#!/usr/bin/env python3
"""Minimal reader for an Electron .asar archive.

Usage:
  asar_read.py ls <asar> <dir-prefix>        # list entries under a prefix
  asar_read.py cat <asar> <path-in-archive>  # print one file
  asar_read.py grep <asar> <path-in-archive> <regex> [context]
"""
import json
import re
import struct
import sys


def load(asar):
    with open(asar, "rb") as f:
        raw = f.read(16)
        # 4(uint32 4) + 4(header pickle size) + 4(header string size) + 4(payload offset)
        header_pickle = struct.unpack("<I", raw[4:8])[0]
        header_size = struct.unpack("<I", raw[12:16])[0]
        f.seek(16)
        header = json.loads(f.read(header_size).decode("utf-8"))
        data_start = 16 + header_pickle
    return header, data_start


def walk(node, prefix, out):
    for name, child in node.get("files", {}).items():
        path = f"{prefix}/{name}" if prefix else name
        if "files" in child:
            walk(child, path, out)
        else:
            out[path] = child
    return out


def main():
    mode, asar = sys.argv[1], sys.argv[2]
    header, data_start = load(asar)
    files = walk(header, "", {})
    if mode == "ls":
        prefix = sys.argv[3] if len(sys.argv) > 3 else ""
        for path in sorted(files):
            if path.startswith(prefix):
                print(path, files[path].get("size"))
    elif mode in ("cat", "grep"):
        target = sys.argv[3]
        entry = files[target]
        with open(asar, "rb") as f:
            f.seek(data_start + int(entry["offset"]))
            blob = f.read(int(entry["size"]))
        text = blob.decode("utf-8", "replace")
        if mode == "cat":
            print(text)
            return
        pattern = re.compile(sys.argv[4])
        context = int(sys.argv[5]) if len(sys.argv) > 5 else 0
        lines = text.splitlines()
        for i, line in enumerate(lines):
            if pattern.search(line):
                lo, hi = max(0, i - context), min(len(lines), i + context + 1)
                for j in range(lo, hi):
                    print(f"{j + 1}:{lines[j]}")
                print("--")


if __name__ == "__main__":
    main()