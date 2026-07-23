from __future__ import annotations

import json
import os
from typing import Any


class BedrockStructuredGenerator:
    def __init__(self, client: Any | None = None) -> None:
        self.model_id = os.environ["BEDROCK_MODEL_ID"]
        self.guardrail_identifier = os.getenv("BEDROCK_GUARDRAIL_IDENTIFIER")
        self.guardrail_version = os.getenv("BEDROCK_GUARDRAIL_VERSION")
        if client is None:
            import boto3
            from botocore.config import Config

            client = boto3.client(
                "bedrock-runtime",
                config=Config(connect_timeout=3, read_timeout=30, retries={"max_attempts": 2}),
            )
        self.client = client

    def generate(
        self,
        *,
        schema_name: str,
        schema: dict[str, Any],
        system_prompt: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        request: dict[str, Any] = {
            "modelId": self.model_id,
            "system": [{"text": system_prompt}],
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "text": json.dumps(
                                payload,
                                ensure_ascii=False,
                                separators=(",", ":"),
                            )
                        }
                    ],
                }
            ],
            "inferenceConfig": {"maxTokens": 1200, "temperature": 0},
            "outputConfig": {
                "textFormat": {
                    "type": "json_schema",
                    "structure": {
                        "jsonSchema": {
                            "name": schema_name,
                            "description": "Yukisaki assistant structured response",
                            "schema": json.dumps(schema, separators=(",", ":")),
                        }
                    },
                }
            },
        }
        if self.guardrail_identifier and self.guardrail_version:
            request["guardrailConfig"] = {
                "guardrailIdentifier": self.guardrail_identifier,
                "guardrailVersion": self.guardrail_version,
                "trace": "enabled",
            }

        response = self.client.converse(**request)
        if response.get("stopReason") == "guardrail_intervened":
            raise RuntimeError("Bedrock Guardrail intervened")
        content = response.get("output", {}).get("message", {}).get("content", [])
        text = "".join(item.get("text", "") for item in content if "text" in item)
        if not text:
            raise RuntimeError("Bedrock returned no structured text")
        result = json.loads(text)
        if not isinstance(result, dict):
            raise RuntimeError("Bedrock response must be an object")
        return result
