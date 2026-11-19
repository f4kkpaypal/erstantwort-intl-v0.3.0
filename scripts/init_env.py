#!/usr/bin/env python3
"""Create .env from .env.example and fill the local secrets.

Safe to run twice: if .env already exists, only missing or still-placeholder secrets are filled in,
every other line (real keys, modes, comments) is left untouched. That matters because the shipped
snapshot already contains a .env, and a fresh .env without ENGINE_TOKEN keeps Compose from starting.
"""

import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / '.env'
EXAMPLE = ROOT / '.env.example'

# key -> (placeholder value used in .env.example, byte length of the generated secret)
PLACEHOLDERS = {
    'N8N_ENCRYPTION_KEY': ('change-me-encryption-key', 32),
    'HASH_SALT': ('change-me-hash-salt', 32),
    'ADMIN_TOKEN': ('change-me-admin-token', 24),
    'POSTGRES_PASSWORD': ('change-me-postgres', 18),
    'ENGINE_TOKEN': ('change-me-engine-token', 24),
}


def token_for(key):
    return secrets.token_hex(PLACEHOLDERS[key][1])


def fill_missing(text):
    """Return text with every placeholder or absent secret replaced by a random value."""
    lines = text.splitlines()
    positions = {}
    for index, line in enumerate(lines):
        stripped = line.strip()
        for key in PLACEHOLDERS:
            if stripped.startswith(f'{key}='):
                positions[key] = index
                break

    changed = False
    for key, (placeholder, _length) in PLACEHOLDERS.items():
        if key in positions:
            index = positions[key]
            value = lines[index].split('=', 1)[1].strip()
            if value == placeholder or value == '':
                lines[index] = f'{key}={token_for(key)}'
                changed = True
        else:
            lines.append(f'{key}={token_for(key)}')
            changed = True
    return ('\n'.join(lines) + '\n') if changed else text


def write_private(path, text):
    path.write_text(text, encoding='utf-8')
    try:
        path.chmod(0o600)
    except OSError:
        pass


def main():
    if ENV.exists():
        original = ENV.read_text(encoding='utf-8')
        updated = fill_missing(original)
        if updated == original:
            print('.env already exists with all required secrets, left untouched')
            return
        write_private(ENV, updated)
        print('.env already existed: filled missing/placeholder secrets, other values untouched')
        return
    text = fill_missing(EXAMPLE.read_text(encoding='utf-8'))
    write_private(ENV, text)
    print('.env created. Mock modes stay on until you add the real keys.')


if __name__ == '__main__':
    main()
