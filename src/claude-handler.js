import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const exec = promisify(execCallback);

/**
 * Normalize escaped newlines in a string (convert literal \n to actual newlines)
 */
function normalizeNewlines(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\\n/g, '\n');
}

// Path to the repo where Claude will work (configure this)
const REPO_PATH = process.env.REPO_PATH || process.cwd();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

/**
 * Run Claude CLI with a prompt and return the output
 */
function runClaude(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
      }
    });

    claude.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Post a comment on a GitHub issue
 */
async function postIssueComment(owner, repo, issueNumber, body) {
  if (!GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN not set - cannot post comment');
    return;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to post comment: ${response.status} ${error}`);
  }

  console.log(`Posted comment on issue #${issueNumber}`);
}

/**
 * Create a pull request
 */
async function createPullRequest(owner, repo, title, body, head, base = 'main') {
  if (!GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN not set - cannot create PR');
    return null;
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, head, base }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create PR: ${response.status} ${error}`);
  }

  const pr = await response.json();
  console.log(`Created PR #${pr.number}: ${pr.html_url}`);
  return pr;
}

/**
 * Main handler for processing GitHub issues
 */
export async function handleIssue({ issueNumber, issueTitle, issueBody, issueUrl, repoOwner, repoName }) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing issue #${issueNumber}: ${issueTitle}`);
  console.log(`${'='.repeat(60)}\n`);

  // Step 1: Ask Claude to analyze if this issue can be resolved automatically
  const analysisPrompt = `You are analyzing a GitHub issue to determine if it can be resolved automatically without human intervention.

Issue #${issueNumber}: ${issueTitle}

Issue Body:
${issueBody || '(No description provided)'}

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
      // Normalize escaped newlines in string values
      for (const key of Object.keys(analysis)) {
        if (typeof analysis[key] === 'string') {
          analysis[key] = normalizeNewlines(analysis[key]);
        }
      }
    } else {
      throw new Error('No JSON found in response');
    }
    console.log('Analysis result:', analysis);
  } catch (error) {
    console.error('Failed to analyze issue:', error);
    await postIssueComment(
      repoOwner,
      repoName,
      issueNumber,
      `🤖 **AutoClaude Analysis Failed**\n\nI encountered an error while trying to analyze this issue. A human will need to review it.\n\nError: ${error.message}`
    );
    return;
  }

  // Step 2: If Claude can't resolve it, comment with findings
  if (!analysis.canResolve) {
    await postIssueComment(
      repoOwner,
      repoName,
      issueNumber,
      `🤖 **AutoClaude Analysis**\n\nI've analyzed this issue and determined that it **cannot be resolved automatically**.\n\n**Reason:** ${analysis.reason}\n\n**Confidence:** ${analysis.confidence}\n\nThis issue requires human attention.`
    );
    return;
  }

  // Step 3: If Claude can resolve it, attempt to create a fix
  const branchName = `autoclaude/issue-${issueNumber}`;

  try {
    // Create a new branch
    await exec(`git checkout -b ${branchName}`, { cwd: REPO_PATH });
    console.log(`Created branch: ${branchName}`);

    // Ask Claude to implement the fix
    const fixPrompt = `You need to fix the following GitHub issue. Make the necessary code changes.

Issue #${issueNumber}: ${issueTitle}

Issue Body:
${issueBody || '(No description provided)'}

Analysis approach: ${analysis.approach}

Instructions:
1. Implement the fix for this issue
2. Make minimal, focused changes
3. Ensure the code is correct and follows existing patterns
4. Do not make unrelated changes

After making changes, provide a brief summary of what you changed.`;

    const fixResultRaw = await runClaude(fixPrompt, REPO_PATH);
    const fixResult = normalizeNewlines(fixResultRaw);
    console.log('Fix result:', fixResult);

    // Check if there are any changes
    const { stdout: statusOutput } = await exec('git status --porcelain', { cwd: REPO_PATH });

    if (!statusOutput.trim()) {
      // No changes were made
      await exec(`git checkout main`, { cwd: REPO_PATH });
      await exec(`git branch -D ${branchName}`, { cwd: REPO_PATH });

      await postIssueComment(
        repoOwner,
        repoName,
        issueNumber,
        `🤖 **AutoClaude Analysis**\n\nI analyzed this issue and attempted to create a fix, but no code changes were necessary or I couldn't determine the exact changes needed.\n\n**My Analysis:**\n${analysis.reason}\n\n**Approach Considered:**\n${analysis.approach}\n\nA human may need to review this issue.`
      );
      return;
    }

    // Commit the changes
    await exec('git add -A', { cwd: REPO_PATH });
    await exec(`git commit -m "fix: resolve issue #${issueNumber} - ${issueTitle}"`, { cwd: REPO_PATH });

    // Push the branch
    await exec(`git push -u origin ${branchName}`, { cwd: REPO_PATH });
    console.log('Pushed branch to origin');

    // Create a pull request
    const prBody = `## Summary
Automated fix for #${issueNumber}

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
      branchName
    );

    // Comment on the issue linking to the PR
    if (pr) {
      await postIssueComment(
        repoOwner,
        repoName,
        issueNumber,
        `🤖 **AutoClaude Fix Created**\n\nI've analyzed this issue and created a fix!\n\n**Pull Request:** #${pr.number}\n**Link:** ${pr.html_url}\n\nPlease review the changes and merge if they look good.`
      );
    }

    // Switch back to main
    await exec('git checkout main', { cwd: REPO_PATH });

  } catch (error) {
    console.error('Failed to create fix:', error);

    // Clean up - try to get back to main
    try {
      await exec('git checkout main', { cwd: REPO_PATH });
      await exec(`git branch -D ${branchName}`, { cwd: REPO_PATH }).catch(() => {});
    } catch (cleanupError) {
      console.error('Cleanup failed:', cleanupError);
    }

    await postIssueComment(
      repoOwner,
      repoName,
      issueNumber,
      `🤖 **AutoClaude Fix Failed**\n\nI analyzed this issue and attempted to create a fix, but encountered an error.\n\n**My Analysis:**\n- **Can Resolve:** Yes (${analysis.confidence} confidence)\n- **Approach:** ${analysis.approach}\n\n**Error:** ${error.message}\n\nA human will need to review this issue.`
    );
  }
}
