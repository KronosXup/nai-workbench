import base64
import io

from PIL import Image

from app.adapters import build_request
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
