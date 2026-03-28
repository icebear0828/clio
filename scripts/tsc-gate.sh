#!/bin/bash
# Post-hook gate: runs tsc --noEmit, reports errors to the model.
# If errors exist, outputs a clear directive for the model to fix them first.
OUTPUT=$(npx tsc --noEmit 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "$OUTPUT" | head -30
  echo ""
  echo "ERROR: TypeScript compilation failed. You MUST fix these type errors before making any other changes."
  exit 1
fi

echo "tsc: ok"
