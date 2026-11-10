#!/usr/bin/env python3
"""Reliable transparent TCP tunnel for a single target endpoint.

Listens on 127.0.0.1:LISTEN_PORT. For each client:
  1. connect to the relay (PROXY_HOST:PROXY_PORT)
  2. issue HTTP CONNECT TARGET_HOST:TARGET_PORT
  3. wait for "200", then bidirectionally pipe raw bytes

This keeps the upstream TLS hostname intact (the relay connects to the
real server, TLS terminates there), so no cert bypass is needed.

Designed to replace the flaky Node model-tunnel-bridge.js. Env-overridable
so it can be smoke-tested on a scratch port before swapping in.
"""
import os
import socket
import sys
import threading

LISTEN_HOST = os.environ.get("BRIDGE_LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("BRIDGE_LISTEN_PORT", "25443"))
TARGET_HOST = os.environ.get("BRIDGE_TARGET_HOST", "45.76.203.143")
TARGET_PORT = int(os.environ.get("BRIDGE_TARGET_PORT", "25443"))
PROXY_HOST = os.environ.get("BRIDGE_PROXY_HOST", "192.168.8.7")
PROXY_PORT = int(os.environ.get("BRIDGE_PROXY_PORT", "18899"))


def pipe(src, dst, tag):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception as e:
        sys.stderr.write(f"[{tag}] pipe ended: {e}\n")
        sys.stderr.flush()
    try:
        dst.shutdown(socket.SHUT_WR)
    except Exception:
        pass


def handle(client):
    peer = None
    proxy = None
    try:
        peer = client.getpeername()
        proxy = socket.create_connection((PROXY_HOST, PROXY_PORT), timeout=15)
        proxy.sendall(
            f"CONNECT {TARGET_HOST}:{TARGET_PORT} HTTP/1.1\r\n"
            f"Host: {TARGET_HOST}:{TARGET_PORT}\r\n"
            f"User-Agent: py-model-bridge/1.0\r\n"
            f"Proxy-Connection: Keep-Alive\r\n\r\n".encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = proxy.recv(4096)
            if not chunk:
                raise RuntimeError("relay closed before 200")
            buf += chunk
        head = buf.split(b"\r\n\r\n")[0].decode("utf-8", "ignore")
        if " 200 " not in head and not head.startswith("HTTP/1.1 200"):
            raise RuntimeError("relay refused: " + head)
        sys.stderr.write(f"[{peer}] tunnel up -> {TARGET_HOST}:{TARGET_PORT}\n")
        sys.stderr.flush()
        t1 = threading.Thread(target=pipe, args=(client, proxy, "c->p"), daemon=True)
        t2 = threading.Thread(target=pipe, args=(proxy, client, "p->c"), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
    except Exception as e:
        sys.stderr.write(f"[{peer}] error: {e}\n")
        sys.stderr.flush()
    finally:
        for s in (client, proxy):
            try:
                s.close()
            except Exception:
                pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((LISTEN_HOST, LISTEN_PORT))
    srv.listen(128)
    sys.stderr.write(
        f"py-bridge listening on {LISTEN_HOST}:{LISTEN_PORT} "
        f"via {PROXY_HOST}:{PROXY_PORT} -> {TARGET_HOST}:{TARGET_PORT}\n"
    )
    sys.stderr.flush()
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
