"""Model IDs that depend on the selected generation operation."""


def effective_model_for_operation(model: str, operation: str) -> str:
    """Return the model family that actually handles this operation."""
    if operation == "inpaint" and model == "nai-diffusion-5-curated":
        # The official V5 Curated inpaint plan submits V4.5 Curated inpainting.
        return "nai-diffusion-4-5-curated"
    return model


def request_model_for_operation(model: str, operation: str) -> str:
    """Resolve the model ID sent upstream after operation-specific mapping."""
    effective = effective_model_for_operation(model, operation)
    if operation == "inpaint" and not effective.endswith("-inpainting"):
        return effective + "-inpainting"
    return effective
