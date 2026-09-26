"""Gate request validation without booting the removed local service."""

import base64
import math
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.config import Settings
from app.task_validation import validate_task


IMAGE = base64.b64encode(
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0bIDATx\x9cc`\x00\x02\x00\x00\x05"
    b"\x00\x01\xa5\xf6E@\x00\x00\x00\x00IEND\xaeB`\x82"
).decode("ascii")


def task(*, model="nai-diffusion-4-5-full", operation="generate"):
    return {
        "request_id": str(uuid4()),
        "operation": operation,
        "model": model,
        "prompt": "test",
        "negative_prompt": "",
        "parameters": {
            "width": 512,
            "height": 512,
            "steps": 28,
            "scale": 5,
            "seed": 123,
            "n_samples": 1,
        },
    }


def reject(payload, *, settings=None, status=422):
    with pytest.raises(HTTPException) as error:
        validate_task(payload, settings or Settings())
    assert error.value.status_code == status


@pytest.mark.parametrize("field,value", [
    ("character_reference_descriptions", "character"),
    ("character_reference_strengths", 0.5),
    ("character_reference_fidelities", 0.5),
    ("character_reference_descriptions", ["character", "style"]),
    ("character_reference_strengths", [0.5, 0.5]),
    ("character_reference_fidelities", [0.5, 0.5]),
    ("character_reference_descriptions", ["unsupported-description"]),
])
def test_precise_reference_arrays_reject_wrong_shapes_or_descriptions(field, value):
    payload = task()
    payload["parameters"].update(character_reference_images=[IMAGE], **{field: value})
    reject(payload)


@pytest.mark.parametrize("field", ["character_reference_strengths", "character_reference_fidelities"])
@pytest.mark.parametrize("value", [True, -0.01, 1.01, float("nan"), float("inf")],
                         ids=["boolean", "negative", "above-one", "nan", "infinity"])
def test_precise_reference_numeric_settings_reject_invalid_values(field, value):
    payload = task()
    payload["parameters"].update(character_reference_images=[IMAGE], **{field: [value]})
    reject(payload)


@pytest.mark.parametrize("case", ["v5-precise", "v5-vibe", "v5-encode-vibe", "v45-precise-and-vibe"])
def test_unsupported_reference_and_vibe_combinations_are_rejected(case):
    is_v5 = case.startswith("v5-")
    payload = task(model="nai-diffusion-5-full" if is_v5 else "nai-diffusion-4-5-full")
    parameters = payload["parameters"]
    if case in {"v5-precise", "v45-precise-and-vibe"}:
        parameters["character_reference_images"] = [IMAGE]
    if case in {"v5-vibe", "v45-precise-and-vibe"}:
        parameters.update(reference_image_multiple=[IMAGE], reference_strength_multiple=[1],
                          reference_information_extracted_multiple=[1])
    if case == "v5-encode-vibe":
        payload["operation"] = "encode_vibe"
        parameters["image"] = IMAGE
    reject(payload)


def test_short_precise_reference_arrays_keep_adapter_defaults():
    payload = task()
    payload["parameters"].update(
        character_reference_images=[IMAGE, IMAGE, IMAGE],
        character_reference_descriptions=["style"],
        character_reference_strengths=[0],
        character_reference_fidelities=[1],
    )
    validated = validate_task(payload, Settings())
    assert validated["parameters"]["character_reference_descriptions"] == ["style"]
    assert validated["parameters"]["character_reference_strengths"] == [0]
    assert validated["parameters"]["character_reference_fidelities"] == [1]


@pytest.mark.parametrize("reference_field", ["character_reference_images", "reference_image_multiple"])
def test_v5_curated_inpaint_accepts_v45_reference_capabilities(reference_field):
    payload = task(model="nai-diffusion-5-curated", operation="inpaint")
    payload["parameters"].update(image=IMAGE, mask=IMAGE, **{reference_field: [IMAGE]})
    validate_task(payload, Settings())


def test_v5_curated_inpaint_uses_six_character_limit_but_normal_v5_keeps_32():
    inpaint = task(model="nai-diffusion-5-curated", operation="inpaint")
    inpaint["parameters"].update(image=IMAGE, mask=IMAGE,
                                 character_prompts=[{"prompt": "character", "x": .5, "y": .5} for _ in range(6)])
    validate_task(inpaint, Settings())
    inpaint["parameters"]["character_prompts"].append({"prompt": "extra", "x": .5, "y": .5})
    reject(inpaint)

    normal = task(model="nai-diffusion-5-curated")
    normal["parameters"]["character_prompts"] = [
        {"prompt": "character", "x": .5, "y": .5} for _ in range(32)
    ]
    validate_task(normal, Settings())
    normal["parameters"]["character_prompts"].append({"prompt": "extra", "x": .5, "y": .5})
    reject(normal)


def test_validation_copies_input_and_enforces_stream_image_mask_and_payload_limits():
    payload = task(operation="inpaint")
    payload["parameters"].update(image=IMAGE, mask=IMAGE, stream=True)
    original = {**payload, "parameters": dict(payload["parameters"])}
    validated = validate_task(payload, Settings())
    assert payload == original
    assert validated["parameters"] is not payload["parameters"]

    invalid_stream = task()
    invalid_stream["parameters"]["stream"] = 1
    reject(invalid_stream)
    missing_image = task(operation="inpaint")
    missing_image["parameters"]["mask"] = IMAGE
    reject(missing_image)
    missing_mask = task(operation="inpaint")
    missing_mask["parameters"]["image"] = IMAGE
    reject(missing_mask)
    oversized = task()
    oversized["prompt"] = "x" * 500
    reject(oversized, settings=Settings(max_input_mb=0.0001), status=413)


def test_reference_numeric_arrays_must_match_image_count():
    payload = task()
    payload["parameters"].update(reference_image_multiple=[IMAGE], reference_strength_multiple=[])
    reject(payload)
    payload["parameters"]["reference_strength_multiple"] = [math.nan]
    reject(payload)
