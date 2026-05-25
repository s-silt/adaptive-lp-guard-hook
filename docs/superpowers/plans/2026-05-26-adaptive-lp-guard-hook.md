# Adaptive LP Guard Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a Solidity MVP for an adaptive Uniswap v4-style dynamic fee hook.

**Architecture:** Keep fee logic in a pure library and stateful hook behavior in a small contract. Tests call the hook contract directly through a deterministic Hardhat local network.

**Tech Stack:** Solidity 0.8.24, Hardhat, Mocha, Chai, ethers.

---

### Task 1: Test Harness And Fee Math

**Files:**
- Create: `package.json`
- Create: `hardhat.config.js`
- Create: `test/adaptiveFeeHook.test.js`
- Create: `contracts/AdaptiveFeeMath.sol`
- Create: `contracts/AdaptiveFeeHook.sol`

- [ ] **Step 1: Write failing tests**

Create tests that deploy `AdaptiveFeeHook`, call `beforeSwapDecision`, and assert fee decisions for calm, volatile, imbalanced, clamped, and cooldown scenarios.

- [ ] **Step 2: Run tests and verify red**

Run: `npm test`

Expected: FAIL because `AdaptiveFeeHook.sol` is missing.

- [ ] **Step 3: Implement minimal contracts**

Create `AdaptiveFeeMath.sol` with pure fee calculation and `AdaptiveFeeHook.sol` with config/state and decision events.

- [ ] **Step 4: Run tests and verify green**

Run: `npm test`

Expected: PASS.

### Task 2: Documentation And Demo Script

**Files:**
- Create: `README.md`
- Create: `scripts/demo.js`
- Create: `.gitignore`

- [ ] **Step 1: Document project and hackathon framing**

Explain motivation, bot-inspired design, contract behavior, setup, tests, and X Layer deployment path.

- [ ] **Step 2: Add demo script**

Deploy the hook locally and print a few decisions for calm, volatile, and cooldown cases.

- [ ] **Step 3: Verify docs commands**

Run: `npm test` and `npm run demo`

Expected: both pass without warnings that block use.

### Task 3: Publish

**Files:**
- Modify: git metadata only

- [ ] **Step 1: Inspect status**

Run: `git status -sb`

Expected: only project files are untracked/modified.

- [ ] **Step 2: Commit**

Run: `git add -A && git commit -m "feat: add adaptive lp guard hook"`

- [ ] **Step 3: Create GitHub repo and push**

Run: `gh repo create adaptive-lp-guard-hook --public --source . --remote origin --push`

Expected: repository exists at `https://github.com/s-silt/adaptive-lp-guard-hook`.
