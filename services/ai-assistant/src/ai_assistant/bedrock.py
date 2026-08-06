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
        # Structured output is obtained via forced tool use (a single tool
        # matching the schema, with toolChoice pinned to it) rather than
        # Bedrock's native outputConfig/json_schema response format. Tool use
        # is supported uniformly across Claude model generations on Bedrock,
        # while the native structured-output response format is not (e.g. it
        # rejects Haiku 4.5 requests with a validation error).
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
            "inferenceConfig": {"maxTokens": 3200, "temperature": 0},
            "toolConfig": {
                "tools": [
                    {
                        "toolSpec": {
                            "name": schema_name,
                            "description": "Yukisaki assistant structured response",
                            "inputSchema": {"json": schema},
                        }
                    }
                ],
                "toolChoice": {"tool": {"name": schema_name}},
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
        tool_use = next((item["toolUse"] for item in content if "toolUse" in item), None)
        if tool_use is None:
            raise RuntimeError("Bedrock returned no structured tool use")
        result = tool_use.get("input")
        if not isinstance(result, dict):
            raise RuntimeError("Bedrock response must be an object")
        return result
