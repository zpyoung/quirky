"""Run one local Jupyter kernel and exchange bounded NDJSON frames over stdio."""

import json
import os
import queue
import sys
import threading
import time

# Frames own stdout; interpreter/import noise is redirected to stderr.
_frames = os.fdopen(os.dup(1), "wb", buffering=0)
os.dup2(2, 1)
sys.stdout = sys.stderr
_frames_lock = threading.Lock()
MAX_TEXT = 512 * 1024
MAX_HTML = 1024 * 1024
MAX_IMAGE = 4 * 1024 * 1024
OUTPUT_TYPES = {
    "stream",
    "display_data",
    "execute_result",
    "update_display_data",
    "clear_output",
    "error",
}
SAFE_MIMES = {
    "text/html",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/jpeg",
    "image/jpg",
    "image/svg+xml",
    "application/json",
    "text/markdown",
    "text/plain",
}


def send(frame):
    line = (json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8")
    with _frames_lock:
        _frames.write(line)


def bounded_text(value, limit):
    if not isinstance(value, str) or len(value) <= limit:
        return value
    return value[:limit] + "\n… output truncated …"


def externally_managed():
    """PEP 668: pip refuses to install into this interpreter outside a virtual environment."""
    import sysconfig

    if sys.prefix != getattr(sys, "base_prefix", sys.prefix):
        return False
    return os.path.isfile(os.path.join(sysconfig.get_path("stdlib"), "EXTERNALLY-MANAGED"))


try:
    import ipykernel  # noqa: F401
    from jupyter_client.kernelspec import KernelSpec
    from jupyter_client.manager import KernelManager
except ImportError:
    send({"type": "missing", "externallyManaged": externally_managed()})
    sys.exit(0)


def bounded_output(msg_type, content):
    if msg_type == "stream":
        content["text"] = bounded_text(content.get("text"), MAX_TEXT)
    elif msg_type in {"display_data", "execute_result", "update_display_data"}:
        data = content.get("data")
        if isinstance(data, dict):
            bounded = {}
            for mime, value in data.items():
                if mime not in SAFE_MIMES:
                    continue
                limit = MAX_IMAGE if mime.startswith("image/") else MAX_HTML if mime == "text/html" else MAX_TEXT
                if isinstance(value, str):
                    bounded[mime] = bounded_text(value, limit)
                elif isinstance(value, list):
                    bounded[mime] = value[:4096]
                else:
                    bounded[mime] = value
            content["data"] = bounded
    elif msg_type == "error":
        content["ename"] = bounded_text(content.get("ename"), 4096)
        content["evalue"] = bounded_text(content.get("evalue"), MAX_TEXT)
        trace = content.get("traceback")
        if isinstance(trace, list):
            content["traceback"] = [bounded_text(line, 8192) for line in trace[:512]]
    return content


def forward(msg):
    msg_type = msg["header"]["msg_type"]
    if msg_type in OUTPUT_TYPES:
        send({"type": msg_type, "content": bounded_output(msg_type, msg["content"])})


def execute_all(client, codes):
    while True:
        code = codes.get()
        reply = client.execute_interactive(code, allow_stdin=False, output_hook=forward)
        content = reply["content"]
        send(
            {
                "type": "done",
                "status": content.get("status"),
                "execution_count": content.get("execution_count"),
            }
        )


def exit_when_dead(manager):
    while manager.is_alive():
        time.sleep(0.5)
    try:
        manager.cleanup_resources()
    finally:
        os._exit(1)


def main():
    manager = KernelManager()
    manager._kernel_spec = KernelSpec(
        argv=[sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name="Python",
        language="python",
    )
    manager.start_kernel()
    client = manager.client()
    client.start_channels()
    try:
        client.wait_for_ready(timeout=60)
    except Exception as error:
        try:
            manager.shutdown_kernel(now=True)
        finally:
            send({"type": "start_error", "detail": str(error)[:4096]})
            sys.exit(1)

    codes = queue.Queue()
    threading.Thread(target=execute_all, args=(client, codes), daemon=True).start()
    threading.Thread(target=exit_when_dead, args=(manager,), daemon=True).start()
    send({"type": "ready"})

    for line in sys.stdin.buffer:
        command = json.loads(line)
        if command.get("op") == "execute":
            code = command.get("code")
            if isinstance(code, str):
                codes.put(code)
        elif command.get("op") == "interrupt":
            manager.interrupt_kernel()
    manager.shutdown_kernel(now=True)
    os._exit(0)


main()
