"""One isolated Hy-Memory operation. JSON stdin/stdout; credentials never enter argv/files."""
import sys, json, os, contextlib, pathlib, logging

# Some SDK dependencies write directly to fd 1. Keep the JSON protocol on a
# separate descriptor and redirect all library output away from that channel.
protocol_fd = os.dup(1)
os.dup2(2, 1)
logging.disable(logging.CRITICAL)

def main():
    request = json.load(sys.stdin)
    if request["action"] == "status":
        from importlib.metadata import version
        return {"installed": True, "version": version("hy-memory")}
    config = request["config"]
    root = pathlib.Path(request["directory"])
    root.mkdir(parents=True, exist_ok=True)
    os.chdir(root)
    os.environ["ANONYMIZED_TELEMETRY"] = "False"
    # Explicit connection config; never fall back to a user's OpenAI environment.
    for key in list(os.environ):
        if key.startswith(("OPENAI_", "MEMORY_", "HY_MEMORY_")):
            del os.environ[key]
    os.environ["MEMORY_DATA_DIR"] = str(root)
    with contextlib.redirect_stdout(sys.stderr):
        from hy_memory import HyMemoryClient
        client = HyMemoryClient.from_config({
            "mode": "lite", "enable_graph": False,
            "embedder": {"provider": "openai", "model": config["model"], "api_key": config["apiKey"], "base_url": config["baseUrl"], "embedding_dims": config["dimensions"]},
            "llm": {"api_key": "unused-lite-mode", "model": "unused-lite-mode"},
            "vector_store": {"provider": "qdrant", "collection_name": "tongpin_memory", "persist_directory": str(root / "vectors"), "embedding_dims": config["dimensions"]},
            "cache": {"backend": "sqlite", "db_path": str(root / "cache.db")},
            "history": {"enable": False, "db_path": str(root / "history.db")},
        })
        try:
            if request["action"] == "add":
                results = []
                for item in request["items"]:
                    result = client.add(item["text"], user_id=request["workspaceId"], source="tongpin", meta={"tongpin_id": item["id"], "title": item["title"]})
                    if not result.get("success"):
                        raise RuntimeError("Hy-Memory did not confirm memory write")
                    results.append({"id": item["id"], "hyId": result.get("memory_id")})
                return {"items": results}
            if request["action"] == "search":
                return client.search(request["query"], user_ids=[request["workspaceId"]], limit=6, min_score=0.15)
            raise ValueError("Unsupported operation")
        finally:
            client.close()

try:
    os.write(protocol_fd, (json.dumps(main(), ensure_ascii=False) + "\n").encode("utf-8"))
except Exception as error:
    # Error strings can contain upstream URLs/secrets. Return only type; no stdout/stderr logs to browser.
    os.write(protocol_fd, (json.dumps({"error": type(error).__name__ + ": Hy-Memory 操作失败，请检查 Embedding 模型、维度、密钥与网络。"}, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.exit(1)
