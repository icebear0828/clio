#!/bin/bash
# Post-hook gate: runs npm test, reports failures to the model.
# Only runs after Write (not every Edit, to avoid excessive test runs).
OUTPUT=$(npm test 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "$OUTPUT" | tail -40
  echo ""
  echo "ERROR: Tests failed. You MUST fix the failing tests before proceeding."
  exit 1
fi

# Extract summary line
echo "$OUTPUT" | grep -E "(Tests|Test Files)" | tail -2
