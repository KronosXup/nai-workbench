import asyncio
import base64
import io
import json

import httpx
import pytest
from PIL import Image, ImageDraw, PngImagePlugin

from app.adapters import AdapterError, NaiAdapter, build_request
from app.config import Settings
from app.inpaint import prepare_mask


def png(image, *, comment=None):
    output = io.BytesIO()
    text = PngImagePlugin.PngInfo()
    if comment:
        text.add_text('Comment', comment)
    image.save(output, format='PNG', pnginfo=text)
    return output.getvalue()


def fixture(*, transparent_mask=False, size=(256, 256), stream=False):
    source = png(Image.new('RGB', size, 'navy'))
    mask = Image.new('RGBA' if transparent_mask else 'RGB', size,
                     (0, 0, 0, 0) if transparent_mask else 'black')
    ImageDraw.Draw(mask).rectangle((size[0] * 3 // 8, size[1] * 3 // 8,
                                    size[0] * 5 // 8, size[1] * 5 // 8), fill='white')
    return dict(operation='inpaint', model='nai-diffusion-5-full', prompt='red square', negative_prompt='',
                parameters=dict(width=size[0], height=size[1],
                                steps=23, scale=7, seed=1, n_samples=1,
                                sampler='k_euler_ancestral', image=base64.b64encode(source).decode(),
                                mask=base64.b64encode(png(mask)).decode(),
                                img2img={'strength': .4}, stream=stream))


def test_inpaint_opaque_and_transparent_masks_use_the_same_selected_area():
    old = fixture()
    new = fixture(transparent_mask=True)
    old_mask = prepare_mask(base64.b64decode(old['parameters']['image']),
                            base64.b64decode(old['parameters']['mask']), 256, 256)
    new_mask = prepare_mask(base64.b64decode(new['parameters']['image']),
                            base64.b64decode(new['parameters']['mask']), 256, 256)
    assert old_mask == new_mask
    with Image.open(io.BytesIO(new_mask)) as mask:
        assert mask.size == (256, 256)
        assert mask.getpixel((0, 0)) == (0, 0, 0)
        assert mask.getpixel((128, 128)) == (255, 255, 255)


def test_inpaint_default_strength_uses_native_infill_parameters():
    job = fixture()
    del job['parameters']['img2img']
    _, body, _ = build_request(job)
    assert 'img2img' not in body['parameters']
    assert body['parameters']['params_version'] == 4


@pytest.mark.parametrize('stream', [False, True])
def test_inpaint_sends_aligned_mask_and_blends_final_and_preview(stream):
    job = fixture(stream=stream)
    rendered = png(Image.new('RGB', (256, 256), 'red'), comment='fixture metadata')
    encoded = base64.b64encode(rendered).decode()
    preview_encoded = base64.b64encode(png(Image.new('RGB', (128, 128), 'red'))).decode()
    received = []

    async def gate(request):
        sent = json.loads(request.content)
        received.append(sent)
        p = sent['parameters']
        assert (sent['action'], sent['model']) == ('infill', 'nai-diffusion-5-full-inpainting')
        assert p['add_original_image'] is False and p['params_version'] == 4
        assert p['img2img'] == {'strength': .4, 'color_correct': True}
        with Image.open(io.BytesIO(base64.b64decode(p['mask']))) as mask:
            assert mask.size == (256, 256)
            assert mask.getpixel((0, 0)) == (0, 0, 0)
            assert mask.getpixel((128, 128)) == (255, 255, 255)
        if stream:
            assert request.url.path == '/ai/generate-image-stream'
            events = ('event: message\ndata: ' + json.dumps({'event_type': 'intermediate', 'image': preview_encoded})
                      + '\n\nevent: final\ndata: ' + json.dumps({'image': encoded}) + '\n\n')
            return httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, text=events)
        assert request.url.path == '/ai/generate-image'
        return httpx.Response(200, headers={'Content-Type': 'image/png'}, content=rendered)

    async def run():
        previews = []
        async def record_preview(value):
            previews.append(value)
        adapter = NaiAdapter(Settings(nai_base_url='http://gate.fixture', nai_token='fixture'),
                             httpx.MockTransport(gate), gate_mode=True)
        try:
            results = await adapter.execute(job, on_preview=record_preview if stream else None)
        finally:
            await adapter.close()
        assert len(results) == 1 and len(received) == 1
        with Image.open(io.BytesIO(results[0].data)) as result:
            assert result.convert('RGB').getpixel((0, 0)) == (0, 0, 128)
            assert result.convert('RGB').getpixel((128, 128)) == (255, 0, 0)
            assert result.info['Comment'] == 'fixture metadata'
        if stream:
            assert len(previews) == 1
            with Image.open(io.BytesIO(base64.b64decode(previews[0]['image']))) as preview:
                assert preview.size == (256, 256)
                assert preview.convert('RGB').getpixel((0, 0)) == (0, 0, 128)
                assert preview.convert('RGB').getpixel((128, 128)) == (255, 0, 0)

    asyncio.run(run())


def test_inpaint_resizes_rounded_source_and_rejects_wrong_or_empty_masks():
    job = fixture(size=(65, 73))
    job['parameters']['width'] = 64
    job['parameters']['height'] = 72
    _, body, _ = build_request(job)
    with Image.open(io.BytesIO(base64.b64decode(body['parameters']['image']))) as source:
        assert source.size == (64, 72)
    with Image.open(io.BytesIO(base64.b64decode(body['parameters']['mask']))) as mask:
        assert mask.size == (64, 72)

    job['parameters']['mask'] = base64.b64encode(png(Image.new('RGB', (64, 64), 'white'))).decode()
    with pytest.raises(AdapterError, match='蒙版尺寸必须与源图一致'):
        build_request(job)
    job = fixture()
    job['parameters']['mask'] = base64.b64encode(png(Image.new('RGB', (256, 256), 'black'))).decode()
    with pytest.raises(AdapterError, match='没有选中'):
        build_request(job)
