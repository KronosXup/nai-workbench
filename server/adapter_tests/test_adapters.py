import asyncio
import base64
import io
import json
import zipfile
from types import SimpleNamespace

import httpx
import pytest
from PIL import Image

from app.adapters import AdapterError, MockAdapter, NaiAdapter, build_request, unpack_images


def png():
    stream = io.BytesIO()
    Image.new("RGB", (64, 64), "white").save(stream, format="PNG")
    return stream.getvalue()


def settings():
    return SimpleNamespace(nai_base_url="https://upstream.test", nai_token="test-only-token", upstream_timeout=5, mock_delay=0)


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


def test_mock_can_run_without_any_upstream():
    async def execute():
        return await MockAdapter(settings()).execute(job(width=320, height=448))
    artifacts = asyncio.run(execute())
    assert artifacts[0].metadata["mock"] is True
    with Image.open(io.BytesIO(artifacts[0].data)) as image:
        assert image.size == (320, 448)
        assert "local mock" in image.info["Software"]


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
