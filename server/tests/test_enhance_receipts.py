import asyncio
import base64
import io
import json

import httpx
import pytest
from PIL import Image

from app.adapters import NaiAdapter, build_request
from app.config import Settings
from app.enhance import prepare_enhance_source
from test_gate_bridge import task, inpaint_images


def test_enhance_cleans_only_recognized_alpha_and_fills_legacy_background():
    image = Image.new('RGBA', (64, 64), (30, 60, 90, 254))
    for i, value in enumerate(b'stealth_pngcomp'):
        for bit in range(8):
            n = i * 8 + bit
            image.putpixel((n // 64, n % 64), (30, 60, 90, 254 | ((value >> (7-bit)) & 1)))
    image.putpixel((30, 30), (30, 60, 90, 1))
    data = io.BytesIO(); image.save(data, format='PNG')
    transparent = Image.open(io.BytesIO(prepare_enhance_source(data.getvalue(), 128, 128, True)))
    assert transparent.size == (128, 128)
    assert transparent.getpixel((120, 120))[3] == 255
    legacy = Image.open(io.BytesIO(prepare_enhance_source(data.getvalue(), 64, 64, False)))
    assert legacy.getpixel((30, 30)) == (255, 255, 255)
    image = Image.new('RGBA', (64, 64), (30, 60, 90, 254))
    data = io.BytesIO(); image.save(data, format='PNG')
    untouched = Image.open(io.BytesIO(prepare_enhance_source(data.getvalue(), 64, 64, True)))
    assert untouched.getpixel((1, 1))[3] == 254


def test_enhance_preparation_does_not_change_normal_img2img():
    source, _ = inpaint_images((64, 64))
    job = task(); job['operation'] = 'img2img'
    job['parameters'].update(image=source, width=128, height=128)
    assert build_request(job)[1]['parameters']['image'] == source
    job['parameters']['enhance'] = True
    sent = build_request(job)[1]['parameters']
    assert 'enhance' not in sent
    assert Image.open(io.BytesIO(base64.b64decode(sent['image']))).size == (128, 128)


@pytest.mark.parametrize('streaming', [False, True])
@pytest.mark.parametrize('inpaint', [False, True])
def test_execution_receipt_survives_image_delivery_and_inpaint(streaming, inpaint):
    source, mask = inpaint_images((64, 64))
    receipt = dict(version=1, source='gate', model='nai-diffusion-5-full-medium', operation='generate',
                   parameters=dict(steps=14, sampler='k_euler_ancestral'), completed_images=1,
                   cost=dict(anlas=0, v5=.6, legacy_free_images=0))
    def upstream(request):
        assert request.headers['x-nai-gate-receipt'] == '1'
        if streaming:
            payload = 'event: gate_receipt\ndata: '+json.dumps({'receipt':receipt})+'\n\n'
            payload += 'event: final\ndata: '+json.dumps({'image':source})+'\n\n'
            return httpx.Response(200, headers={'content-type':'text/event-stream'}, text=payload)
        return httpx.Response(200, headers={'x-nai-gate-receipt':json.dumps(receipt)}, content=base64.b64decode(source))
    async def run():
        job = task(); job['parameters']['stream'] = streaming
        if inpaint:
            job['operation'] = 'inpaint'
            job['parameters'].update(image=source, mask=mask, width=64, height=64)
        adapter = NaiAdapter(Settings(nai_token='fixture'), httpx.MockTransport(upstream), gate_mode=True)
        try:
            results = await adapter.execute(job)
            assert results[0].metadata['gate_receipt'] == receipt
            assert results[0].metadata['width'] == 64
        finally:
            await adapter.close()
    asyncio.run(run())
