#!/usr/bin/env bash
set -euo pipefail

VALID_TYPES=("patch" "minor" "major")
BUMP_TYPE="${1:-}"

if [[ -z "$BUMP_TYPE" ]]; then
  echo "Usage: $0 <patch|minor|major>" >&2
  exit 1
fi

if [[ ! " ${VALID_TYPES[*]} " =~ " ${BUMP_TYPE} " ]]; then
  echo "Error: invalid bump type '$BUMP_TYPE'. Must be one of: ${VALID_TYPES[*]}" >&2
  exit 1
fi

CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

NEW_VERSION=$(npm version "$BUMP_TYPE" --no-git-tag-version)
echo "Bumped to: $NEW_VERSION"

git add package.json package-lock.json 2>/dev/null || git add package.json
git commit -m "release: ${NEW_VERSION}"
git tag "$NEW_VERSION"

echo ""
echo "Done. To publish:"
echo "  git push && git push --tags"
echo "  npm publish"
