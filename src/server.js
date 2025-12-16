import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { handleIssue } from './claude-handler.js';

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const GITHUB_MENTION_USER = process.env.GITHUB_MENTION_USER;

// Parse JSON body
app.use(express.json());

// Verify GitHub webhook signature
function verifySignature(req) {
  if (!WEBHOOK_SECRET) {
    console.warn('WEBHOOK_SECRET not set - skipping signature verification');
    return true;
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    return false;
  }

  const body = JSON.stringify(req.body);
  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(body)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// GitHub webhook endpoint
app.post('/webhook/github', async (req, res) => {
  // Verify signature
  if (!verifySignature(req)) {
    console.error('Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.headers['x-github-event'];
  const payload = req.body;

  console.log(`Received GitHub event: ${event}`);

  // Handle issue_comment events (when user is mentioned)
  if (event === 'issue_comment') {
    if (payload.action !== 'created') {
      return res.json({ message: 'Action ignored', action: payload.action });
    }

    const comment = payload.comment;
    const issue = payload.issue;
    const repository = payload.repository;

    // Check if the configured user is mentioned in the comment
    if (!GITHUB_MENTION_USER) {
      console.log('GITHUB_MENTION_USER not configured, ignoring comment');
      return res.json({ message: 'Mention user not configured' });
    }

    const mentionPattern = `@${GITHUB_MENTION_USER}`;
    if (!comment.body || !comment.body.includes(mentionPattern)) {
      return res.json({ message: 'No matching mention found' });
    }

    console.log(`User @${GITHUB_MENTION_USER} mentioned in comment on issue #${issue.number}`);

    // Respond immediately to avoid timeout
    res.json({ message: 'Comment mention received, processing...' });

    // Process the issue asynchronously
    try {
      await handleIssue({
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body || '',
        issueUrl: issue.html_url,
        repoOwner: repository.owner.login,
        repoName: repository.name,
        repoFullName: repository.full_name,
        commentBody: comment.body,
      });
    } catch (error) {
      console.error('Error processing issue from comment:', error);
    }
    return;
  }

  // Handle issue events
  if (event !== 'issues') {
    return res.json({ message: 'Event ignored', event });
  }

  // Only handle opened issues
  if (payload.action !== 'opened') {
    return res.json({ message: 'Action ignored', action: payload.action });
  }

  const issue = payload.issue;
  const repository = payload.repository;

  console.log(`Processing issue #${issue.number}: ${issue.title}`);

  // Respond immediately to avoid timeout
  res.json({ message: 'Issue received, processing...' });

  // Process the issue asynchronously
  try {
    await handleIssue({
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueBody: issue.body || '',
      issueUrl: issue.html_url,
      repoOwner: repository.owner.login,
      repoName: repository.name,
      repoFullName: repository.full_name,
    });
  } catch (error) {
    console.error('Error processing issue:', error);
  }
});

app.listen(PORT, () => {
  console.log(`AutoClaude server running on port ${PORT}`);
});
