import { exec as execCallback, spawn } from "child_process";
import { promisify } from "util";

const exec = promisify(execCallback);

// Path to the repo where Claude will work (configure this)
const REPO_PATH = process.env.REPO_PATH || process.cwd();

/**
 * Run Claude CLI by piping prompt to stdin (using -p flag hangs)
 */
function runClaude(prompt, cwd) {
  console.log("Running Claude CLI...");

  return new Promise((resolve, reject) => {
    const claude = spawn(
      "claude",
      ["--output-format", "text", "--dangerously-skip-permissions"],
      {
        cwd,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      claude.kill();
      reject(new Error("Claude CLI timed out"));
    }, 300000);

    claude.stdout.on("data", (data) => {
      stdout += data.toString();
      process.stdout.write(data); // Show output in real-time
    });

    claude.stderr.on("data", (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    claude.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
      }
    });

    claude.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    // Pipe prompt to stdin and close it
    claude.stdin.write(prompt);
    claude.stdin.end();
  });
}

/**
 * Post a comment on a GitHub issue or PR using gh CLI
 */
function postComment(owner, repo, number, body, isPullRequest = false) {
  const command = isPullRequest ? "pr" : "issue";
  return new Promise((resolve, reject) => {
    const gh = spawn("gh", [
      command,
      "comment",
      String(number),
      "--repo",
      `${owner}/${repo}`,
      "--body-file",
      "-",
    ]);

    gh.on("close", (code) => {
      if (code === 0) {
        console.log(`Posted comment on ${command} #${number}`);
        resolve();
      } else {
        const error = new Error(`Failed to post comment on ${command} #${number}`);
        console.error(error.message);
        reject(error);
      }
    });

    gh.on("error", (err) => {
      console.error("Failed to post comment:", err.message);
      reject(err);
    });

    gh.stdin.write(body);
    gh.stdin.end();
  });
}

/**
 * Get PR information including head branch using gh CLI
 */
async function getPullRequestInfo(owner, repo, prNumber) {
  try {
    const { stdout } = await exec(
      `gh pr view ${prNumber} --repo ${owner}/${repo} --json headRefName,baseRefName`,
    );
    return JSON.parse(stdout);
  } catch (error) {
    console.error("Failed to get PR info:", error.message);
    throw error;
  }
}

/**
 * Create a pull request using gh CLI
 */
async function createPullRequest(
  owner,
  repo,
  title,
  body,
  head,
  base = "main",
) {
  return new Promise((resolve, reject) => {
    const gh = spawn("gh", [
      "pr",
      "create",
      "--repo",
      `${owner}/${repo}`,
      "--title",
      title,
      "--head",
      head,
      "--base",
      base,
      "--body-file",
      "-",
    ]);

    let stdout = "";
    gh.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    gh.on("close", (code) => {
      if (code === 0) {
        const prUrl = stdout.trim();
        const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
        const prNumber = prNumberMatch ? prNumberMatch[1] : null;

        console.log(`Created PR: ${prUrl}`);
        resolve({ number: prNumber, html_url: prUrl });
      } else {
        reject(new Error(`gh pr create exited with code ${code}`));
      }
    });

    gh.on("error", reject);

    gh.stdin.write(body);
    gh.stdin.end();
  });
}

/**
 * Main handler for processing GitHub issues or PR comments
 */
export async function handleIssue({
  issueNumber,
  issueTitle,
  issueBody,
  issueUrl,
  repoOwner,
  repoName,
  commentBody,
  isPullRequest = false,
  pullRequestUrl = null,
}) {
  const itemType = isPullRequest ? "PR" : "issue";
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Processing ${itemType} #${issueNumber}: ${issueTitle}`);
  console.log(`${"=".repeat(60)}\n`);

  // Build context based on whether this is a PR comment or an issue
  const contextDescription = isPullRequest
    ? `You are analyzing a comment on a GitHub Pull Request to determine if the requested changes can be made automatically.`
    : `You are analyzing a GitHub issue to determine if it can be resolved automatically without human intervention.`;

  const taskDescription =
    isPullRequest && commentBody
      ? `Comment requesting changes:\n${commentBody}`
      : `Issue Body:\n${issueBody || "(No description provided)"}`;

  // Step 1: Ask Claude to analyze if this can be resolved automatically
  const analysisPrompt = `${contextDescription}

${isPullRequest ? "PR" : "Issue"} #${issueNumber}: ${issueTitle}

${taskDescription}

Analyze this issue and respond in the following JSON format ONLY (no markdown, no code blocks, just raw JSON):
{
  "canResolve": true/false,
  "confidence": "high/medium/low",
  "reason": "Brief explanation of why this can or cannot be resolved automatically",
  "approach": "If canResolve is true, describe the approach to fix it. If false, leave empty.",
  "estimatedComplexity": "simple/moderate/complex"
}

An issue CAN be resolved automatically if:
- It's a clear bug with an obvious fix
- It's a simple feature addition with clear requirements
- It's a documentation update
- It's a refactoring task with clear scope
- It's a dependency update or version bump

An issue CANNOT be resolved automatically if:
- It requires clarification from the issue author
- It involves major architectural decisions
- It's vague or lacks sufficient detail
- It requires access to external systems or credentials
- It involves security-sensitive changes that need human review`;

  let analysis;
  try {
    const analysisResult = await runClaude(analysisPrompt, REPO_PATH);
    // Extract JSON from the response (in case Claude wraps it)
    const jsonMatch = analysisResult.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      analysis = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error("No JSON found in response");
    }
    console.log("Analysis result:", analysis);
  } catch (error) {
    console.error(`Failed to analyze ${itemType}:`, error);
    await postComment(
      repoOwner,
      repoName,
      issueNumber,
      `🤖 **AutoClaude Analysis Failed**

I encountered an error while trying to analyze this ${itemType}. A human will need to review it.

Error: ${error.message}`,
      isPullRequest,
    );
    return;
  }

  // Step 2: If Claude can't resolve it, comment with findings
  if (!analysis.canResolve) {
    await postComment(
      repoOwner,
      repoName,
      issueNumber,
      `🤖 **AutoClaude Analysis**

I've analyzed this ${itemType} and determined that it **cannot be resolved automatically**.

**Reason:** ${analysis.reason}

**Confidence:** ${analysis.confidence}

This ${itemType} requires human attention.`,
      isPullRequest,
    );
    return;
  }

  // Step 3: If Claude can resolve it, attempt to create a fix
  let branchName;
  let baseBranch = "main";

  try {
    if (isPullRequest) {
      // For PRs: checkout the existing PR branch
      const prInfo = await getPullRequestInfo(repoOwner, repoName, issueNumber);
      branchName = prInfo.headRefName;
      baseBranch = prInfo.baseRefName;

      // Fetch and checkout the PR branch
      await exec(`git fetch origin ${branchName}`, { cwd: REPO_PATH });
      await exec(`git checkout ${branchName}`, { cwd: REPO_PATH });
      console.log(`Checked out PR branch: ${branchName}`);
    } else {
      // For issues: create a new branch
      branchName = `autoclaude/issue-${issueNumber}`;
      await exec(`git checkout -b ${branchName}`, { cwd: REPO_PATH });
      console.log(`Created branch: ${branchName}`);
    }

    // Build the fix prompt based on whether this is a PR or issue
    const fixPromptContext =
      isPullRequest && commentBody
        ? `You need to address the following comment/request on a GitHub Pull Request. Make the necessary code changes.

PR #${issueNumber}: ${issueTitle}

Comment requesting changes:
${commentBody}`
        : `You need to fix the following GitHub issue. Make the necessary code changes.

Issue #${issueNumber}: ${issueTitle}

Issue Body:
${issueBody || "(No description provided)"}`;

    const fixPrompt = `${fixPromptContext}

Analysis approach: ${analysis.approach}

Instructions:
1. Implement the fix for this ${itemType}
2. Make minimal, focused changes
3. Ensure the code is correct and follows existing patterns
4. Do not make unrelated changes
5. IMPORTANT: Do NOT commit the changes. Only make file modifications. The commit will be handled externally.

After making changes, provide a brief summary of what you changed.`;

    const fixResult = await runClaude(fixPrompt, REPO_PATH);
    console.log("Fix result:", fixResult);

    // Check if there are any uncommitted changes
    const { stdout: statusOutput } = await exec("git status --porcelain", {
      cwd: REPO_PATH,
    });

    // Also check if Claude made any commits (in case it committed despite instructions)
    let hasNewCommits = false;
    try {
      if (isPullRequest) {
        // For PRs: check if there are new commits since we fetched
        const { stdout: commitDiff } = await exec(
          `git log origin/${branchName}..HEAD --oneline`,
          { cwd: REPO_PATH },
        );
        hasNewCommits = commitDiff.trim().length > 0;
      } else {
        // For issues: check if there are commits ahead of base branch
        const { stdout: commitDiff } = await exec(
          `git log origin/${baseBranch}..HEAD --oneline`,
          { cwd: REPO_PATH },
        );
        hasNewCommits = commitDiff.trim().length > 0;
      }
    } catch {
      // Fallback: check against local branch
      try {
        const compareBranch = isPullRequest ? baseBranch : baseBranch;
        const { stdout: commitDiff } = await exec(
          `git log ${compareBranch}..HEAD --oneline`,
          { cwd: REPO_PATH },
        );
        hasNewCommits = commitDiff.trim().length > 0;
      } catch {
        hasNewCommits = false;
      }
    }

    const hasUncommittedChanges = statusOutput.trim().length > 0;

    if (!hasUncommittedChanges && !hasNewCommits) {
      // No changes were made
      if (!isPullRequest) {
        await exec(`git checkout main`, { cwd: REPO_PATH });
        await exec(`git branch -D ${branchName}`, { cwd: REPO_PATH });
      } else {
        await exec(`git checkout main`, { cwd: REPO_PATH });
      }

      await postComment(
        repoOwner,
        repoName,
        issueNumber,
        `🤖 **AutoClaude Analysis**

I analyzed this ${itemType} and attempted to create a fix, but no code changes were necessary or I couldn't determine the exact changes needed.

**My Analysis:**
${analysis.reason}

**Approach Considered:**
${analysis.approach}

A human may need to review this ${itemType}.`,
        isPullRequest,
      );
      return;
    }

    // Commit the changes (only if there are uncommitted changes)
    if (hasUncommittedChanges) {
      await exec("git add -A", { cwd: REPO_PATH });
      const commitMessage = isPullRequest
        ? `fix: address review comments on PR #${issueNumber}`
        : `fix: resolve issue #${issueNumber} - ${issueTitle}`;
      await exec(`git commit -m "${commitMessage}"`, { cwd: REPO_PATH });
    } else if (hasNewCommits) {
      console.log("Claude already committed the changes, skipping commit step");
    }

    // Push the branch
    if (isPullRequest) {
      // For PRs: push to existing branch
      await exec(`git push origin ${branchName}`, { cwd: REPO_PATH });
      console.log(`Pushed changes to PR branch: ${branchName}`);

      // Comment on the PR that changes were made
      await postComment(
        repoOwner,
        repoName,
        issueNumber,
        `🤖 **AutoClaude Changes Pushed**

I've addressed the requested changes and pushed a new commit to this PR.

**Changes Made:**
${fixResult}

**Analysis:**
- **Confidence:** ${analysis.confidence}
- **Complexity:** ${analysis.estimatedComplexity}
- **Approach:** ${analysis.approach}

Please review the new changes.`,
        true,
      );
    } else {
      // For issues: push new branch and create PR
      await exec(`git push -u origin ${branchName}`, { cwd: REPO_PATH });
      console.log("Pushed branch to origin");

      // Create a pull request with "Fixes #XXX" to auto-close the issue
      const prBody = `## Summary
Automated fix for #${issueNumber}

Fixes #${issueNumber}

## Changes
${fixResult}

## Analysis
- **Confidence:** ${analysis.confidence}
- **Complexity:** ${analysis.estimatedComplexity}
- **Approach:** ${analysis.approach}

---
🤖 This PR was automatically generated by AutoClaude.`;

      const pr = await createPullRequest(
        repoOwner,
        repoName,
        `fix: ${issueTitle} (Issue #${issueNumber})`,
        prBody,
        branchName,
        baseBranch,
      );

      // Comment on the issue linking to the PR
      if (pr) {
        await postComment(
          repoOwner,
          repoName,
          issueNumber,
          `🤖 **AutoClaude Fix Created**

I've analyzed this issue and created a fix!

**Pull Request:** #${pr.number}
**Link:** ${pr.html_url}

Please review the changes and merge if they look good. The issue will be automatically closed when the PR is merged.`,
          false,
        );
      }
    }

    // Switch back to main
    await exec("git checkout main", { cwd: REPO_PATH });
  } catch (error) {
    console.error("Failed to create fix:", error);

    // Clean up - try to get back to main
    try {
      await exec("git checkout main", { cwd: REPO_PATH });
      if (!isPullRequest && branchName) {
        await exec(`git branch -D ${branchName}`, { cwd: REPO_PATH }).catch(
          () => {},
        );
      }
    } catch (cleanupError) {
      console.error("Cleanup failed:", cleanupError);
    }

    await postComment(
      repoOwner,
      repoName,
      issueNumber,
      `🤖 **AutoClaude Fix Failed**

I analyzed this ${itemType} and attempted to create a fix, but encountered an error.

**My Analysis:**
- **Can Resolve:** Yes (${analysis.confidence} confidence)
- **Approach:** ${analysis.approach}

**Error:** ${error.message}

A human will need to review this ${itemType}.`,
      isPullRequest,
    );
  }
}
