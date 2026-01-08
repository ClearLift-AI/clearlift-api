#!/bin/bash
# Apply migrations to all shard databases

set -e

MIGRATION_DIR="shard-migrations"
SHARDS=(
  "clearlift-shard-0"
  "clearlift-shard-1"
  "clearlift-shard-2"
  "clearlift-shard-3"
)

echo "=========================================="
echo "Applying migrations to D1 shards"
echo "=========================================="

for shard in "${SHARDS[@]}"; do
  echo ""
  echo "--- Applying to $shard ---"

  for migration in "$MIGRATION_DIR"/*.sql; do
    if [ -f "$migration" ]; then
      echo "  Applying: $(basename "$migration")"
      wrangler d1 execute "$shard" --remote --file="$migration" 2>&1 | grep -v "^$" | head -5
    fi
  done

  echo "  Done with $shard"
done

echo ""
echo "=========================================="
echo "All shard migrations complete!"
echo "=========================================="
