# Daily Rhythm Skill Test Suite

## 🧪 Overview

This test suite validates the **daily-rhythm** skill's ability to:
- Compose morning briefings (busy vs. light days)
- Create evening wind-down messages
- Generate weekly reviews
- Follow formatting and tone guidelines

## 📁 Files

- `test_daily_rhythm.py` — Main test script with 4 test scenarios
- `run_tests.sh` — Shell script to execute tests (Linux/macOS)
- `expected_output.txt` — Sample output for comparison

## 🚀 Running the Tests

### Option 1: Direct Python Execution

```bash
cd /Users/munzihirwa/Documents/flopsy/FlopsyBot/src/agent/src/skills/daily-rhythm
python3 test_daily_rhythm.py
```

### Option 2: Shell Script (recommended)

```bash
chmod +x run_tests.sh
./run_tests.sh
```

## 🧪 Test Scenarios

| Test | Description | Expected Checks |
|------|-------------|------------------|
| **T1** | Morning Briefing - Busy Day | Schedule narrative, back-to-back flags, overdue tasks, weather impact, urgent emails |
| **T2** | Morning Briefing - Light Day | Relaxed tone, deep work suggestions, no guilt-tripping |
| **T3** | Evening Wind-Down - Productive Day | Celebratory tone, completed tasks acknowledged, rollover without guilt, tomorrow preview |
| **T4** | Weekly Review | Week vibe, specific wins, rollover acknowledgment, simple stats, patterns identified, next week snapshot, top 3 priorities |

## 📊 Test Results

Run the tests and check `test_results.json` for detailed output:

```json
[
  {
    "test": "Morning Briefing - Schedule narrative present",
    "status": "✅ PASS",
    "passed": true
  }
]
```

## ✏️ Adding New Tests

1. Create a new method in `test_daily_rhythm.py`
2. Follow the existing pattern (input → compose → validate)
3. Add test to `run_tests.sh` using `python3 test_daily_rhythm.py`
4. Run and verify results

## 🐛 Troubleshooting

- **Python not found**: Install Python 3.9+ via Homebrew: `brew install python`
- **Permission denied**: Run `chmod +x test_daily_rhythm.py`
- **Import errors**: Ensure you're in the correct directory

## 📝 Notes

- Tests are designed to validate **structure and tone** from the SKILL.md
- Actual tool calls (productivity subagent, weather, etc.) are simulated
- Focus is on message composition quality, not integration testing
