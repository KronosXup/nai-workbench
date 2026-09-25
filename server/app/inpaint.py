"""Prepare an inpaint mask and put the generated region back on its source image."""

from __future__ import annotations

import io

from PIL import Image, ImageFilter, PngImagePlugin


def prepare_mask(source_data: bytes, mask_data: bytes, width: int, height: int) -> bytes:
    """Turn a painted selection into the block-aligned mask used by image generation.

    Transparent masks select by alpha. Older workbench masks were opaque black
    and white, so they select by brightness instead.
    """
    with Image.open(io.BytesIO(source_data)) as source, Image.open(io.BytesIO(mask_data)) as mask:
        expected = (width, height)
        if source.size != mask.size:
            raise ValueError("蒙版尺寸必须与源图一致")
        rgba = mask.convert("RGBA")
        alpha = rgba.getchannel("A")
        selection = alpha if alpha.getextrema() != (255, 255) else rgba.convert("L")
        # The official canvas resolves the selection on the model's 8-pixel grid.
        reduced = selection.resize((width // 8, height // 8), Image.Resampling.LANCZOS)
        reduced = reduced.point(lambda value: 255 if value > 155 else 0)
        if not reduced.getbbox():
            raise ValueError("蒙版没有选中可重绘的区域")
        aligned = reduced.resize(expected, Image.Resampling.NEAREST)
        output = io.BytesIO()
        aligned.convert("RGB").save(output, format="PNG")
        return output.getvalue()


def normalize_source(source_data: bytes, width: int, height: int) -> bytes:
    """Match the source to the size used for both the API mask and final image."""
    with Image.open(io.BytesIO(source_data)) as source:
        if source.size == (width, height):
            return source_data
        output = io.BytesIO()
        source.convert("RGB").resize((width, height), Image.Resampling.LANCZOS).save(output, format="PNG")
        return output.getvalue()


def composite_result(source_data: bytes, mask_data: bytes, generated_data: bytes, *, preview: bool = False) -> bytes:
    """Blend an API inpaint result into the source while retaining PNG text metadata."""
    with (Image.open(io.BytesIO(source_data)) as source,
          Image.open(io.BytesIO(mask_data)) as mask,
          Image.open(io.BytesIO(generated_data)) as generated):
        if source.size != mask.size:
            raise ValueError("局部重绘结果与源图尺寸不一致")
        if source.size != generated.size:
            if not preview or source.width * generated.height != source.height * generated.width:
                raise ValueError("局部重绘结果与源图尺寸不一致")
            rendered = generated.convert("RGBA").resize(source.size, Image.Resampling.BILINEAR)
        else:
            rendered = generated.convert("RGBA")
        low = mask.convert("L").resize(
            (source.width // 8, source.height // 8), Image.Resampling.NEAREST
        )
        # Include nearby pixels for a natural seam, then soften the transition.
        blend = low.filter(ImageFilter.MaxFilter(9)).resize(source.size, Image.Resampling.NEAREST)
        blend = blend.filter(ImageFilter.GaussianBlur(20))
        result = Image.composite(rendered, source.convert("RGBA"), blend)
        text = PngImagePlugin.PngInfo()
        for key, value in generated.info.items():
            if isinstance(value, str):
                text.add_text(key, value)
        output = io.BytesIO()
        result.save(output, format="PNG", pnginfo=text)
        return output.getvalue()
