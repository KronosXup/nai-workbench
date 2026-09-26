from dataclasses import dataclass


@dataclass
class Settings:
    max_input_mb: float = 25
    nai_token: str = ""
    nai_base_url: str = "https://image.novelai.net"
    upstream_timeout: float = 180
