import asyncio
import base64
import io
import json
import zipfile
from types import SimpleNamespace

import httpx
import pytest
from PIL import Image

from app.adapters import AdapterError, NaiAdapter, build_request, unpack_images


def png():
    stream = io.BytesIO()
    Image.new("RGB", (64, 64), "white").save(stream, format="PNG")
    return stream.getvalue()


def settings():
    return SimpleNamespace(nai_base_url="https://upstream.test", nai_token="test-only-token", upstream_timeout=5)


def job(**params):
    return {"id": "job-one", "operation": "generate", "model": "nai-diffusion-4-5-full", "prompt": "test", "negative_prompt": "lowres", "parameters": {"width": 832, "height": 1216, "steps": 28, "scale": 5, "seed": 9, "sampler": "k_euler_ancestral", **params}}


def run_execute(handler, request_job=None, preview=None):
    async def run():
        adapter = NaiAdapter(settings(), transport=httpx.MockTransport(handler))
        try:
            return await adapter.execute(request_job or job(), preview)
        finally:
            await adapter.close()
    return asyncio.run(run())


def test_generation_mapping_does_not_mutate_saved_snapshot():
    source = job(character_prompts=[{"prompt": "character A", "negative_prompt": "hat", "x": .2, "y": .8}], extra_model_field={"nested": [1, 2]})
    before = json.dumps(source, sort_keys=True)
    path, body, stream = build_request(source)
    assert path == "/ai/generate-image"
    assert not stream
    assert body["parameters"]["v4_prompt"]["caption"]["char_captions"][0]["centers"] == [{"x": .2, "y": .8}]
    assert body["parameters"]["extra_model_field"] == {"nested": [1, 2]}
    assert json.dumps(source, sort_keys=True) == before


@pytest.mark.parametrize("stream", [False, True])
def test_img2img_noise_seed_and_color_defaults(stream):
    source = job(image=base64.b64encode(png()).decode(), strength=.8, noise=.1,
                 stream=stream, color_correct=True, sm=True, sm_dyn=True)
    source["operation"] = "img2img"
    source["model"] = "nai-diffusion-5-curated"
    before = json.dumps(source, sort_keys=True)
    path, body, actual_stream = build_request(source)
    assert actual_stream is stream
    assert path == ("/ai/generate-image-stream" if stream else "/ai/generate-image")
    params = body["parameters"]
    assert params["extra_noise_seed"] == 8
    assert params["color_correct"] is False
    assert params["sm"] is False and params["sm_dyn"] is False
    assert json.dumps(source, sort_keys=True) == before
    source["parameters"]["extra_noise_seed"] = 123
    assert build_request(source)[1]["parameters"]["extra_noise_seed"] == 123


@pytest.mark.parametrize("model", ["nai-diffusion-4-5-full", "nai-diffusion-5-curated", "nai-diffusion-5-full"])
@pytest.mark.parametrize("coords", [False, True])
def test_character_positioning_matches_official_caption_flags(model, coords):
    source = job(use_coords=coords, character_prompts=[
        {"prompt": "woman, red jacket", "negative_prompt": "hat", "x": .75, "y": .274},
        {"prompt": "", "negative_prompt": "ignored", "x": .5, "y": .5},
        {"prompt": "disabled", "enabled": False, "x": .5, "y": .5},
        {"prompt": "man, blue jacket", "negative_prompt": "glasses", "x": .23, "y": .774},
    ])
    source["model"] = model
    params = build_request(source)[1]["parameters"]
    positive, negative = params["v4_prompt"], params["v4_negative_prompt"]
    assert positive["use_coords"] is coords
    assert positive["use_order"] is True
    assert negative["use_coords"] is False
    assert negative["use_order"] is False
    assert [c["centers"] for c in positive["caption"]["char_captions"]] == [
        [{"x": .75, "y": .274}], [{"x": .23, "y": .774}],
    ]
    assert [c["centers"] for c in negative["caption"]["char_captions"]] == [
        c["centers"] for c in positive["caption"]["char_captions"]
    ]
    assert [c["char_caption"] for c in negative["caption"]["char_captions"]] == ["hat", "glasses"]


@pytest.mark.parametrize("stream", [False, True])
def test_v5_euler_ancestral_uses_current_official_sampler_behavior(stream):
    source = job(stream=stream, prefer_brownian=False, deliberate_euler_ancestral_bug=True)
    source["model"] = "nai-diffusion-5-curated"
    params = build_request(source)[1]["parameters"]
    assert params["prefer_brownian"] is True
    assert params["deliberate_euler_ancestral_bug"] is False
    assert source["parameters"]["prefer_brownian"] is False


def test_zip_multiple_results_are_all_kept_without_extracting_paths():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("../../outside.png", png())
        archive.writestr("second.png", png())
    artifacts = unpack_images(stream.getvalue())
    assert len(artifacts) == 2
    assert artifacts[0].filename == "outside.png"
    assert all(a.media_type == "image/png" for a in artifacts)


def test_empty_or_broken_result_is_not_success():
    with pytest.raises(AdapterError) as error:
        unpack_images(b"PK-not-a-zip")
    assert error.value.uncertain


def test_preview_without_final_is_unknown_not_a_completed_image():
    image = base64.b64encode(png()).decode()
    previews = []
    async def on_preview(payload):
        previews.append(payload)
    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text=f'event: intermediate\ndata: {json.dumps({"image": image, "step": 1})}\n\n')
    with pytest.raises(AdapterError) as error:
        run_execute(handler, job(stream=True), on_preview)
    assert error.value.code == "missing_final"
    assert error.value.uncertain
    assert len(previews) == 1


def test_final_sse_and_event_type_inside_json_are_supported():
    encoded = base64.b64encode(png()).decode()
    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, text='data: ' + json.dumps({"event_type": "final", "image": encoded}) + '\n\n')
    result = run_execute(handler, job(stream=True))
    assert len(result) == 1
    assert result[0].data == png()


def test_documented_json_final_marker_and_201_response():
    def handler(request):
        return httpx.Response(201, json={"image": base64.b64encode(png()).decode(), "final": True, "ptr": 1})
    assert run_execute(handler)[0].data == png()


def test_documented_sse_boolean_final_marker():
    def handler(request):
        return httpx.Response(201, headers={"content-type": "text/event-stream"}, text='data: ' + json.dumps({"image": base64.b64encode(png()).decode(), "final": True}) + '\n\n')
    assert run_execute(handler, job(stream=True))[0].data == png()


def test_upstream_failure_does_not_leak_echoed_secrets_or_retry():
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(500, text="echo: test-only-token private-prompt")
    with pytest.raises(AdapterError) as error:
        run_execute(handler)
    assert len(calls) == 1
    assert error.value.uncertain
    assert "test-only-token" not in str(error.value)
    assert "private-prompt" not in str(error.value)


def test_rate_limit_is_explicit_and_not_retried():
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(429, headers={"retry-after": "42"})
    with pytest.raises(AdapterError) as error:
        run_execute(handler)
    assert error.value.retry_after == 42
    assert not error.value.uncertain
    assert len(calls) == 1


def test_ambiguous_read_timeout_is_unknown_and_not_retried():
    calls = []
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("late failure", request=request)
    with pytest.raises(AdapterError) as error:
        run_execute(handler)
    assert error.value.uncertain
    assert len(calls) == 1


def test_precise_reference_uses_full_cached_data_and_inverse_fidelity():
    source = job(character_reference_images=[base64.b64encode(png()).decode()], character_reference_descriptions=["character&style"], character_reference_strengths=[.75], character_reference_fidelities=[.8])
    before = json.dumps(source, sort_keys=True)
    _, body, _ = build_request(source)
    params = body["parameters"]
    ref = params["director_reference_images_cached"][0]
    assert len(ref["cache_secret_key"]) == 64
    int(ref["cache_secret_key"], 16)
    with Image.open(io.BytesIO(base64.b64decode(ref["data"]))) as result:
        assert result.size == (1472, 1472)
        assert result.getpixel((0, 0)) == (255, 255, 255)
    assert params["director_reference_descriptions"][0]["caption"]["base_caption"] == "character&style"
    assert params["director_reference_strength_values"] == [.75]
    assert params["director_reference_secondary_strength_values"] == pytest.approx([.2])
    assert params["director_reference_information_extracted"] == [1]
    assert "character_reference_images" not in params
    assert json.dumps(source, sort_keys=True) == before


def test_precise_reference_padding_defaults_and_cache_key_stability():
    stream = io.BytesIO()
    Image.new("RGB", (64, 256), "white").save(stream, format="PNG")
    source = job(character_reference_images=[base64.b64encode(stream.getvalue()).decode()])
    _, first, _ = build_request(source)
    _, second, _ = build_request(source)
    params = first["parameters"]
    assert params["director_reference_images_cached"] == second["parameters"]["director_reference_images_cached"]
    assert params["director_reference_strength_values"] == [1]
    assert params["director_reference_secondary_strength_values"] == [0]
    with Image.open(io.BytesIO(base64.b64decode(params["director_reference_images_cached"][0]["data"]))) as result:
        assert result.size == (1024, 1536)
        assert result.getpixel((0, 0)) == (0, 0, 0)
        assert result.getpixel((512, 768)) == (255, 255, 255)


@pytest.mark.parametrize("change,expected", [
    ({"model": "nai-diffusion-5-full"}, "unsupported_reference"),
    ({"parameters": {"reference_image_multiple": ["vibe-data"]}}, "incompatible_references"),
    ({"parameters": {"character_reference_fidelities": [float("nan")]}}, "invalid_reference"),
])
def test_invalid_precise_reference_is_rejected_before_network(change, expected):
    source = job(character_reference_images=[base64.b64encode(png()).decode()])
    source["parameters"].update(change.get("parameters", {}))
    if "model" in change:
        source["model"] = change["model"]
    with pytest.raises(AdapterError) as error:
        build_request(source)
    assert error.value.code == expected
    assert not error.value.uncertain


def test_mock_vibe_encoding_is_rejected_before_network():
    source = job(reference_image_multiple=["MOCK:local-diagnostic"])
    with pytest.raises(AdapterError) as error:
        build_request(source)
    assert error.value.code == "mock_reference"


def test_broken_upload_is_definite_failure_without_contacting_upstream():
    calls = []
    def handler(request):
        calls.append(request)
        raise AssertionError("bad uploads must not reach upstream")
    source = job(character_reference_images=[base64.b64encode(b"not-an-image").decode()])
    with pytest.raises(AdapterError) as error:
        run_execute(handler, source)
    assert error.value.code == "invalid_image"
    assert not error.value.uncertain
    assert calls == []
