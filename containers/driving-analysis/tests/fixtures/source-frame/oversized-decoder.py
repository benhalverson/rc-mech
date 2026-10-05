#!/usr/bin/env python3
import sys

sys.stdout.buffer.write(b"x" * (9 * 1024 * 1024))
