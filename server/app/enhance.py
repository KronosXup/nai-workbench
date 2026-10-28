"""Prepare Enhance sources using the official client's documented image steps."""

import io

from PIL import Image


def prepare_enhance_source(data: bytes, width: int, height: int, transparent: bool) -> bytes:
    with Image.open(io.BytesIO(data)) as source:
        image = source.convert("RGBA")
    signature = b"stealth_pngcomp"
    if len(signature) * 8 <= image.width * image.height <= 0x1000000:
        pixels = image.load()
        decoded = bytes(sum((pixels[(i * 8 + bit) // image.height, (i * 8 + bit) % image.height][3] & 1)
                            << (7 - bit) for bit in range(8)) for i in range(len(signature)))
        if decoded == signature:
            image.putalpha(image.getchannel("A").point(lambda a: 255 if a == 254 else 0 if a == 1 else a))
    if image.size != (width, height):
        image = image.resize((width, height), Image.Resampling.LANCZOS)
    if not transparent:
        background = Image.new("RGBA", image.size, "white")
        image = Image.alpha_composite(background, image).convert("RGB")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()
