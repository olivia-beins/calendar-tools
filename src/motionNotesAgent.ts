/**
 * Notes → Tasks agent with LLM parsing and intelligent project inference
 */

import { MotionProject } from './motionProjects.js';
import { MotionClient, MotionTaskInput } from './motionClient.js';
import { createInterface } from 'readline';

export type RawTask = {
  title: string;
  description?: string;
  dueDate?: string; // ISO 8601
  duration: number; // minutes, required
  priority?: 'low' | 'medium' | 'high' | 'asap';
  projectHint?: string; // exact project name from the available list
  autoScheduled: {
    startDate: string; // ISO 8601
    deadlineType: 'SOFT' | 'HARD';
    schedule: string;
  };
};

/**
 * Returns the next business day (Mon–Fri) at 09:00 UTC
 */
function getNextBusinessDay(from: Date): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  d.setUTCHours(9, 0, 0, 0);
  return d;
}

export type ProjectMatch = {
  projectId?: string;
  matchedName?: string;
  confidence: number;
};

export type CoverageEntry = {
  originalNote: string;
  task: string;
  project: string;
  batched: boolean;
  reason: string;
};

/**
 * Default project ID to use when no match is found
 * Can be overridden via DEFAULT_PROJECT_ID environment variable
 */
function getDefaultProjectId(): string {
  const envDefault = process.env.DEFAULT_PROJECT_ID;
  if (envDefault && envDefault.trim() !== '') {
    return envDefault.trim();
  }
  // TODO: Replace with your default project ID, or set DEFAULT_PROJECT_ID in .env
  return '<ADD_YOUR_DEFAULT_PROJECT_ID>';
}

/**
 * Triage project ID to use when no match is found
 * Can be overridden via TRIAGE_PROJECT_ID environment variable
 */
function getTriageProjectId(): string | null {
  const envTriage = process.env.TRIAGE_PROJECT_ID;
  if (envTriage && envTriage.trim() !== '') {
    return envTriage.trim();
  }
  return null;
}

const DEFAULT_PROJECT: string = getDefaultProjectId();

/**
 * Parse messy notes into structured tasks using OpenAI LLM
 */
export async function parseNotesToTasks(notes: string, projects: MotionProject[] = []): Promise<{ tasks: RawTask[]; coverageMap: CoverageEntry[] }> {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const currentDateFormatted = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const nextBizDay = getNextBusinessDay(now).toISOString();

  const projectList = projects.length > 0
    ? `\nAvailable projects (set projectHint to EXACTLY one of these names):\n${projects.map(p => `- ${p.name}`).join('\n')}\n`
    : '';

  const prompt = `You are a task generation assistant. Parse the following notes into Motion API tasks.

Today: ${currentDateFormatted} (${currentDate})
Next business day: ${nextBizDay}
${projectList}
━━━ OWNERSHIP RULE ━━━
Only create tasks for the user ("I", "me"). Ignore tasks assigned to others.
If ownership is unclear but important, create: "Clarify ownership: <topic>" (30m, LOW).

━━━ AGGRESSIVE BATCHING ━━━
Batch tasks when they are:
  • ≤15–20 minutes each, OR
  • Similar context (admin / comms / review / follow-ups), OR
  • Same workstream follow-ups
Default bias: BATCH unless clearly deep work.

Do NOT batch if:
  • Deep work / core deliverable
  • High-stakes single outcome
  • 60+ minutes on its own

Batch format:
  title: concise name for the work session
  description: Markdown checklist  "- [ ] (10m) subtask"
  duration: sum of subtasks rounded to nearest 15m (min 30m, max 120m per task)
  If total >120m → split into two tasks titled "... (#1)" and "... (#2)"

━━━ DURATION (required on every task) ━━━
Estimate in minutes. Round to nearest 15m.

━━━ AUTO-SCHEDULED (required on every task) ━━━
  startDate: "${nextBizDay}"
  deadlineType: "SOFT" (use "HARD" only if clearly non-negotiable)
  schedule: "Work Hours"

━━━ DEFAULT DUE DATES ━━━
Use these unless the notes specify a date:
  ASAP / HIGH  → 2–5 business days from today
  MEDIUM       → 1–2 weeks from today
  LOW          → 3–6 weeks from today
All dates must be ${now.getFullYear()} or later, ISO 8601 with .000Z.

━━━ PRIORITY ━━━
Values: "asap" | "high" | "medium" | "low". Default: "medium".

━━━ PROJECT ASSIGNMENT ━━━
Set projectHint to EXACTLY one of the project names listed above (character-for-character).
If nothing fits clearly, or task is personal/ambiguous → use "Triage".

━━━ OUTPUT FORMAT ━━━
Return valid JSON only:
{
  "coverageMap": [
    {
      "originalNote": "brief quote of the source note item",
      "task": "task title it became (or batch title)",
      "project": "main project name or Triage",
      "batched": true,
      "reason": "why batched or standalone"
    }
  ],
  "tasks": [
    {
      "title": "Task title",
      "description": "optional — use markdown checklist for batches",
      "dueDate": "2026-04-02T17:00:00.000Z",
      "duration": 60,
      "priority": "medium",
      "projectHint": "Exact Project Name",
      "autoScheduled": {
        "startDate": "${nextBizDay}",
        "deadlineType": "SOFT",
        "schedule": "Work Hours"
      }
    }
  ]
}

Notes to parse:
${notes}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that extracts tasks from notes and returns valid JSON.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('No content in OpenAI response');
    }

    // Parse JSON response
    let parsed: { tasks?: RawTask[]; coverageMap?: CoverageEntry[] };
    try {
      parsed = JSON.parse(content);
    } catch (parseError) {
      console.error('❌ Failed to parse LLM response as JSON:');
      console.error('Raw content:', content);
      throw new Error('LLM output is not valid JSON');
    }

    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error('LLM response missing "tasks" array');
    }

    return {
      tasks: parsed.tasks as RawTask[],
      coverageMap: Array.isArray(parsed.coverageMap) ? parsed.coverageMap as CoverageEntry[] : [],
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('LLM')) {
      throw error;
    }
    throw new Error(`Failed to parse notes: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Calculate Jaccard similarity between two sets of words
 */
function jaccardSimilarity(set1: Set<string>, set2: Set<string>): number {
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

/**
 * Tokenize text into words (lowercase, alphanumeric only)
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2) // Filter out very short words
  );
}

/**
 * Infer project ID from task content using string similarity
 * Returns the best match found, even if confidence is low
 */
export function inferProjectId(
  task: RawTask,
  allProjects: MotionProject[]
): ProjectMatch {
  if (allProjects.length === 0) {
    return { confidence: 0 };
  }

  // Exact match first — GPT is instructed to use the precise project name
  if (task.projectHint) {
    const exactMatch = allProjects.find(
      p => p.name.toLowerCase() === task.projectHint!.toLowerCase()
    );
    if (exactMatch) {
      return { projectId: exactMatch.id, matchedName: exactMatch.name, confidence: 1.0 };
    }
  }

  // Build search text from task
  const searchTexts: string[] = [];
  if (task.projectHint) {
    searchTexts.push(task.projectHint);
  }
  if (task.title) {
    searchTexts.push(task.title);
  }
  if (task.description) {
    searchTexts.push(task.description);
  }

  const taskTokens = tokenize(searchTexts.join(' '));

  let bestMatch: { project: MotionProject; score: number } | null = null;

  for (const project of allProjects) {
    // Build project search text
    const projectTexts: string[] = [project.name];
    if (project.description) {
      projectTexts.push(project.description);
    }

    const projectTokens = tokenize(projectTexts.join(' '));
    const projectNameTokens = tokenize(project.name);

    // Calculate base Jaccard similarity
    const similarity = jaccardSimilarity(taskTokens, projectTokens);

    // Boost score if projectHint matches project name (exact or substring)
    let boostedScore = similarity;
    if (task.projectHint) {
      const hintLower = task.projectHint.toLowerCase();
      const nameLower = project.name.toLowerCase();
      if (nameLower.includes(hintLower) || hintLower.includes(nameLower)) {
        boostedScore = Math.max(boostedScore, 0.85);
      }
    }

    // Boost if key project name words appear in task (especially important words)
    const projectNameWords = Array.from(projectNameTokens);
    const importantProjectWords = projectNameWords.filter(word => 
      word.length > 4 && // Focus on substantial words
      !['planning', 'alignment', 'project', 'program'].includes(word) // Common generic words
    );
    
    let nameWordMatches = 0;
    for (const word of importantProjectWords) {
      if (taskTokens.has(word)) {
        nameWordMatches++;
      }
    }
    
    // If any important project name words match, boost significantly
    if (nameWordMatches > 0 && importantProjectWords.length > 0) {
      const nameMatchRatio = nameWordMatches / importantProjectWords.length;
      // Boost by up to 0.4 based on how many key words match
      boostedScore = Math.max(boostedScore, similarity + (nameMatchRatio * 0.4));
    }

    // Semantic matching: check for related concepts
    // "roadmap", "planning", "strategy" are related
    // "timing", "schedule", "planning" are related
    const semanticPairs: [string[], string[]][] = [
      [['roadmap', 'strategy', 'plan'], ['planning', 'alignment']],
      [['timing', 'schedule', 'timeline'], ['planning']],
      [['fleet'], ['fleet']],
      [['2026', '2025', '2027'], ['2026', '2025', '2027']],
    ];

    for (const [taskConcepts, projectConcepts] of semanticPairs) {
      const hasTaskConcept = taskConcepts.some(concept => 
        Array.from(taskTokens).some(token => token.includes(concept) || concept.includes(token))
      );
      const hasProjectConcept = projectConcepts.some(concept =>
        Array.from(projectTokens).some(token => token.includes(concept) || concept.includes(token))
      );
      
      if (hasTaskConcept && hasProjectConcept) {
        boostedScore = Math.max(boostedScore, similarity + 0.3);
      }
    }

    // If project name contains year and task mentions planning/roadmap, boost
    const hasYearInProject = /\b(20\d{2})\b/.test(project.name);
    const hasPlanningTerms = Array.from(taskTokens).some(token => 
      ['plan', 'roadmap', 'strategy', 'timing', 'schedule'].some(term => 
        token.includes(term) || term.includes(token)
      )
    );
    if (hasYearInProject && hasPlanningTerms) {
      boostedScore = Math.max(boostedScore, similarity + 0.25);
    }

    if (!bestMatch || boostedScore > bestMatch.score) {
      bestMatch = { project, score: boostedScore };
    }
  }

  // Return the best match we found, even if confidence is low
  // This allows the system to work without a default project
  if (!bestMatch) {
    return { confidence: 0 };
  }

  return {
    projectId: bestMatch.project.id,
    matchedName: bestMatch.project.name,
    confidence: bestMatch.score,
  };
}

/**
 * Find a triage project by ID (from env) or by searching for projects with "triage" in the name
 */
function findTriageProject(allProjects: MotionProject[]): MotionProject | null {
  // First, try to find by TRIAGE_PROJECT_ID environment variable
  const triageProjectId = getTriageProjectId();
  if (triageProjectId) {
    const projectById = allProjects.find(project => project.id === triageProjectId);
    if (projectById) {
      return projectById;
    }
  }

  // Otherwise, search for projects with "triage" in the name
  const triageProject = allProjects.find(project => {
    const name = (project.name || '').toLowerCase();
    return name.includes('triage');
  });
  return triageProject || null;
}

/**
 * Assign project to task, falling back to triage project if no match found
 * Uses triage project if confidence is below threshold (0.25)
 */
export function assignProject(
  raw: RawTask,
  allProjects: MotionProject[]
): { projectId: string; matchedName: string; confidence: number } {
  const match = inferProjectId(raw, allProjects);
  const CONFIDENCE_THRESHOLD = 0.25; // Below this, use triage/default project

  // If we found a match with adequate confidence, use it
  if (match.projectId && match.confidence >= CONFIDENCE_THRESHOLD) {
    return {
      projectId: match.projectId,
      matchedName: match.matchedName || 'Unknown',
      confidence: match.confidence,
    };
  }

  // Low confidence match or no match - try to find triage project first
  const triageProject = findTriageProject(allProjects);
  if (triageProject) {
    return {
      projectId: triageProject.id,
      matchedName: triageProject.name || 'Triage',
      confidence: match.confidence || 0, // Preserve the low confidence score for logging
    };
  }

  // No triage project found - try to use default project if configured
  if (DEFAULT_PROJECT !== '<ADD_YOUR_DEFAULT_PROJECT_ID>') {
    return {
      projectId: DEFAULT_PROJECT,
      matchedName: 'default',
      confidence: match.confidence || 0, // Preserve the low confidence score for logging
    };
  }

  // No match, no triage project, and no default - this is an error
  throw new Error(
    `No project match found for task "${raw.title}" and no triage project or default project configured. ` +
    `Please either: (1) create a project with "triage" in the name, (2) set TRIAGE_PROJECT_ID in .env, or (3) set DEFAULT_PROJECT_ID in .env`
  );
}

/**
 * Normalize priority value to Motion API format
 * Valid values: ASAP, HIGH, MEDIUM, LOW
 */
function normalizePriority(priority?: string): string | undefined {
  if (!priority) {
    return undefined;
  }

  const normalized = priority.trim().toUpperCase();
  
  // Direct matches (case-insensitive)
  if (normalized === 'ASAP') {
    return 'ASAP';
  }
  if (normalized === 'HIGH') {
    return 'HIGH';
  }
  if (normalized === 'MEDIUM') {
    return 'MEDIUM';
  }
  if (normalized === 'LOW') {
    return 'LOW';
  }

  // Map common variations
  const priorityMap: Record<string, string> = {
    'URGENT': 'ASAP',
    'CRITICAL': 'ASAP',
    'IMMEDIATE': 'ASAP',
    'PRIORITY': 'HIGH',
    'IMPORTANT': 'HIGH',
    'NORMAL': 'MEDIUM',
    'STANDARD': 'MEDIUM',
    'LOW_PRIORITY': 'LOW',
    'MINOR': 'LOW',
  };

  if (priorityMap[normalized]) {
    return priorityMap[normalized];
  }

  // If it contains keywords, map accordingly
  if (normalized.includes('URGENT') || normalized.includes('CRITICAL') || normalized.includes('IMMEDIATE')) {
    return 'ASAP';
  }
  if (normalized.includes('HIGH') || normalized.includes('IMPORTANT') || normalized.includes('PRIORITY')) {
    return 'HIGH';
  }
  if (normalized.includes('MEDIUM') || normalized.includes('NORMAL') || normalized.includes('STANDARD')) {
    return 'MEDIUM';
  }
  if (normalized.includes('LOW') || normalized.includes('MINOR')) {
    return 'LOW';
  }

  // Default to MEDIUM if we can't determine
  console.warn(`⚠️  Unknown priority value "${priority}", defaulting to MEDIUM`);
  return 'MEDIUM';
}

/**
 * Convert RawTask to MotionTaskInput format
 * Uses the provided assignment instead of recalculating
 */
export function rawTaskToMotionInput(
  task: RawTask,
  assignment: { projectId: string; matchedName: string; confidence: number },
  workspaceId: string
): MotionTaskInput {
  // Build description with project inference info
  let description = task.description || '';
  if (assignment.confidence > 0) {
    const inferenceNote = `\n\n[Inferred project: ${assignment.matchedName} (confidence: ${(assignment.confidence * 100).toFixed(0)}%)]`;
    description = description ? description + inferenceNote : inferenceNote.trim();
  }

  // Normalize priority to valid Motion API values
  const priority = normalizePriority(task.priority);

  return {
    name: task.title,
    workspaceId,
    projectId: assignment.projectId,
    description: description || undefined,
    dueDate: task.dueDate,
    duration: task.duration,
    priority,
    autoScheduled: task.autoScheduled,
  };
}

export type TaskReview = {
  task: RawTask;
  assignment: {
    projectId: string;
    matchedName: string;
    confidence: number;
  };
  motionInput: MotionTaskInput;
};

/**
 * Prepare tasks and project assignments for review
 */
export async function prepareTasksForReview(
  notes: string,
  apiKey: string,
  workspaceId: string
): Promise<{ tasks: RawTask[]; projects: MotionProject[]; reviews: TaskReview[] }> {
  // Step 1: Fetch projects first so GPT can pick exact names
  console.log('📁 Fetching Motion projects...');
  const { fetchMotionProjects } = await import('./motionProjects.js');
  const projects = await fetchMotionProjects(apiKey, workspaceId);
  console.log(`✅ Found ${projects.length} project(s)\n`);

  console.log('📝 Parsing notes into tasks...\n');

  // Step 2: Parse notes to tasks (projects passed for LLM matching)
  let tasks: RawTask[];
  let coverageMap: CoverageEntry[];
  try {
    ({ tasks, coverageMap } = await parseNotesToTasks(notes, projects));
  } catch (error) {
    console.error('❌ Failed to parse notes:', error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }

  if (tasks.length === 0) {
    console.log('ℹ️  No tasks extracted from notes. Exiting.');
    throw new Error('No tasks extracted from notes');
  }

  console.log(`✅ Parsed ${tasks.length} task(s)\n`);

  // Display coverage map for traceability
  if (coverageMap.length > 0) {
    console.log('📋 Coverage Map:');
    coverageMap.forEach(entry => {
      const batchLabel = entry.batched ? ' [batched]' : '';
      console.log(`   • "${entry.originalNote}"`);
      console.log(`     → ${entry.task} (${entry.project})${batchLabel}: ${entry.reason}`);
    });
    console.log('');
  }

  // Step 3: Prepare reviews with project assignments
  const reviews: TaskReview[] = tasks.map(task => {
    const assignment = assignProject(task, projects);
    const motionInput = rawTaskToMotionInput(task, assignment, workspaceId);
    return {
      task,
      assignment,
      motionInput,
    };
  });

  return { tasks, projects, reviews };
}

/**
 * Display review of tasks and project assignments
 */
export function displayReview(reviews: TaskReview[]): void {
  console.log('\n' + '='.repeat(70));
  console.log('📋 TASK REVIEW - Project Assignments');
  console.log('='.repeat(70) + '\n');

  reviews.forEach((review, idx) => {
    const { task, assignment } = review;
    const confidencePercent = (assignment.confidence * 100).toFixed(0);
    const confidenceEmoji = assignment.confidence >= 0.7 ? '✅' : assignment.confidence >= 0.25 ? '⚠️' : '❌';

    console.log(`${idx + 1}. ${task.title}`);
    
    if (task.description) {
      const desc = task.description.length > 100 
        ? task.description.substring(0, 100) + '...'
        : task.description;
      console.log(`   Description: ${desc}`);
    }

    console.log(`   ${confidenceEmoji} Project: ${assignment.matchedName} (${confidencePercent}% confidence)`);
    
    if (task.dueDate) {
      const dueDate = new Date(task.dueDate).toLocaleDateString();
      console.log(`   📅 Due: ${dueDate}`);
    }

    if (task.duration) {
      const hrs = Math.floor(task.duration / 60);
      const mins = task.duration % 60;
      const durationStr = hrs > 0 ? `${hrs}h${mins > 0 ? ` ${mins}m` : ''}` : `${mins}m`;
      console.log(`   ⏱️  Duration: ${durationStr}`);
    }

    if (task.priority) {
      console.log(`   ⚡ Priority: ${task.priority.toUpperCase()}`);
    }

    if (assignment.confidence < 0.25) {
      console.log(`   ⚠️  Low confidence - using default project`);
    }

    console.log('');
  });

  console.log('='.repeat(70));
}

export type ReviewAction =
  | { kind: 'yes' }
  | { kind: 'no' }
  | { kind: 'triage_all' }
  | { kind: 'proceed'; overrides: Map<number, string | 'triage'> };

/**
 * Prompt user for confirmation with per-task override support.
 *
 * Accepts:
 *   y            proceed with shown assignments
 *   n            cancel
 *   t            send all to triage
 *   1=t          send task 1 to triage
 *   2=Fleet      reassign task 2 to a project (partial name match)
 *   1=t 3=Pricing  multiple overrides, space-separated (then proceed)
 */
export function promptForReviewAction(
  reviews: TaskReview[],
  allProjects: MotionProject[]
): Promise<ReviewAction> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log('\nOptions: y=proceed  n=cancel  t=all-triage  or per-task like: 1=t  2=ProjectName');
    rl.question('> ', (answer: string) => {
      rl.close();
      const input = answer.trim().toLowerCase();

      if (input === 'n' || input === 'no') return resolve({ kind: 'no' });
      if (input === 'y' || input === 'yes') return resolve({ kind: 'yes' });
      if (input === 't' || input === 'triage') return resolve({ kind: 'triage_all' });

      // Try to parse per-task overrides: "1=t 2=Fleet"
      const tokens = answer.trim().split(/\s+(?=\d+=)/); // split on whitespace before N=
      const overrides = new Map<number, string | 'triage'>();
      let parseOk = true;

      for (const token of tokens) {
        const eqIdx = token.indexOf('=');
        if (eqIdx === -1) { parseOk = false; break; }
        const taskNum = parseInt(token.slice(0, eqIdx), 10);
        const value = token.slice(eqIdx + 1).trim();
        if (isNaN(taskNum) || taskNum < 1 || taskNum > reviews.length) { parseOk = false; break; }

        if (value.toLowerCase() === 't' || value.toLowerCase() === 'triage') {
          overrides.set(taskNum, 'triage');
        } else {
          // Find best matching project by partial name
          const valueLower = value.toLowerCase();
          const match = allProjects.find(p => p.name.toLowerCase().includes(valueLower));
          if (match) {
            overrides.set(taskNum, match.name);
          } else {
            console.log(`   ⚠️  No project matching "${value}" found — sending task ${taskNum} to triage`);
            overrides.set(taskNum, 'triage');
          }
        }
      }

      if (parseOk && overrides.size > 0) {
        return resolve({ kind: 'proceed', overrides });
      }

      console.log('   ⚠️  Unrecognised input, cancelling.');
      resolve({ kind: 'no' });
    });
  });
}

/**
 * Apply per-task overrides to reviews
 */
function applyOverrides(
  reviews: TaskReview[],
  overrides: Map<number, string | 'triage'>,
  allProjects: MotionProject[]
): TaskReview[] {
  const triageProject = findTriageProject(allProjects);

  return reviews.map((review, idx) => {
    const override = overrides.get(idx + 1); // overrides are 1-indexed
    if (!override) return review;

    let project: MotionProject | undefined;
    if (override === 'triage') {
      project = triageProject ?? undefined;
    } else {
      project = allProjects.find(p => p.name === override);
    }

    if (!project) return review;

    const newAssignment = { projectId: project.id, matchedName: project.name, confidence: 1.0 };
    return {
      ...review,
      assignment: newAssignment,
      motionInput: rawTaskToMotionInput(review.task, newAssignment, review.motionInput.workspaceId),
    };
  });
}

/**
 * Reassign all tasks to triage project
 */
export function reassignAllToTriage(
  reviews: TaskReview[],
  allProjects: MotionProject[]
): TaskReview[] {
  const triageProject = findTriageProject(allProjects);
  
  if (!triageProject) {
    throw new Error(
      'No triage project found. Please create a project with "triage" in the name or set TRIAGE_PROJECT_ID in .env'
    );
  }

  return reviews.map(review => {
    const newAssignment = {
      projectId: triageProject.id,
      matchedName: triageProject.name || 'Triage',
      confidence: 0, // Mark as triage assignment
    };
    
    const newMotionInput = rawTaskToMotionInput(review.task, newAssignment, review.motionInput.workspaceId);
    
    return {
      ...review,
      assignment: newAssignment,
      motionInput: newMotionInput,
    };
  });
}

/**
 * Create tasks in Motion after review confirmation
 */
export async function createTasksFromReviews(
  reviews: TaskReview[],
  apiKey: string,
  workspaceId: string
): Promise<void> {
  const client = new MotionClient(apiKey, workspaceId);
  const results = {
    successful: [] as Array<{ title: string; id: string; project: string; confidence: number }>,
    failed: [] as Array<{ title: string; error: string }>,
    skipped: [] as Array<{ title: string; reason: string }>,
  };

  // Cache of existing task names per project (fetched lazily)
  const existingTaskNames = new Map<string, Set<string>>();

  async function getExistingNames(projectId: string): Promise<Set<string>> {
    if (existingTaskNames.has(projectId)) return existingTaskNames.get(projectId)!;
    try {
      const tasks = await client.getTasksByProject(projectId);
      const names = new Set(tasks.map(t => t.name.trim().toLowerCase()));
      existingTaskNames.set(projectId, names);
      return names;
    } catch {
      // If fetch fails, proceed without duplicate check for this project
      existingTaskNames.set(projectId, new Set());
      return existingTaskNames.get(projectId)!;
    }
  }

  console.log('\n🚀 Creating tasks in Motion...\n');

  for (let i = 0; i < reviews.length; i++) {
    const review = reviews[i];
    const taskNumber = i + 1;

    try {
      console.log(`[${taskNumber}/${reviews.length}] Creating: ${review.task.title}`);
      if (review.assignment.confidence === 0 && review.assignment.matchedName.toLowerCase().includes('triage')) {
        console.log(`   📥 Project: ${review.assignment.matchedName} (sent to triage)`);
      } else {
        console.log(`   Project: ${review.assignment.matchedName} (confidence: ${(review.assignment.confidence * 100).toFixed(0)}%)`);
      }
      if (review.assignment.matchedName === 'default') {
        console.log(`   Using default project ID: ${review.assignment.projectId}`);
      }

      // Duplicate check
      const existingNames = await getExistingNames(review.assignment.projectId);
      if (existingNames.has(review.task.title.trim().toLowerCase())) {
        console.log(`   ⏭️  Skipped — task already exists in ${review.assignment.matchedName}\n`);
        results.skipped.push({ title: review.task.title, reason: `already exists in ${review.assignment.matchedName}` });
        continue;
      }

      const created = await client.createTask(review.motionInput);
      // Add to cache so a second identical task in the same batch is also caught
      existingNames.add(review.task.title.trim().toLowerCase());
      results.successful.push({
        title: review.task.title,
        id: created.id,
        project: review.assignment.matchedName,
        confidence: review.assignment.confidence,
      });
      console.log(`   ✅ Created (ID: ${created.id})\n`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`   ❌ Failed: ${errorMessage}\n`);
      results.failed.push({
        title: review.task.title,
        error: errorMessage,
      });
    }
  }

  // Summary
  console.log('📊 Summary:');
  console.log(`   ✅ Successful: ${results.successful.length}/${reviews.length}`);
  console.log(`   ⏭️  Skipped (duplicates): ${results.skipped.length}/${reviews.length}`);
  console.log(`   ❌ Failed: ${results.failed.length}/${reviews.length}\n`);

  if (results.successful.length > 0) {
    console.log('✅ Created tasks:');
    results.successful.forEach((result, idx) => {
      console.log(`   ${idx + 1}. ${result.title}`);
      console.log(`      Project: ${result.project} (${(result.confidence * 100).toFixed(0)}% confidence)`);
      console.log(`      ID: ${result.id}`);
    });
    console.log('');
  }

  if (results.failed.length > 0) {
    console.log('❌ Failed tasks:');
    results.failed.forEach((result, idx) => {
      console.log(`   ${idx + 1}. ${result.title} - ${result.error}`);
    });
    console.log('');
  }
}

/**
 * High-level wrapper: create tasks from notes with review step
 */
export async function createTasksFromNotes(
  notes: string,
  apiKey: string,
  workspaceId: string,
  forceTriage: boolean = false
): Promise<void> {
  // Prepare tasks and reviews
  const { reviews, projects } = await prepareTasksForReview(notes, apiKey, workspaceId);

  // Display review
  displayReview(reviews);

  let finalReviews = reviews;

  // If forceTriage is true, skip prompt and reassign all to triage
  if (forceTriage) {
    console.log('\n🔄 Reassigning all tasks to triage project...');
    finalReviews = reassignAllToTriage(reviews, projects);
    console.log('✅ All tasks reassigned to triage\n');
  } else {
    const action = await promptForReviewAction(reviews, projects);

    if (action.kind === 'no') {
      console.log('\n❌ Task creation cancelled by user.');
      return;
    }

    if (action.kind === 'triage_all') {
      console.log('\n🔄 Reassigning all tasks to triage project...');
      finalReviews = reassignAllToTriage(reviews, projects);
      console.log('✅ All tasks reassigned to triage\n');
    } else if (action.kind === 'proceed' && action.overrides.size > 0) {
      finalReviews = applyOverrides(reviews, action.overrides, projects);
      console.log(`✅ Applied ${action.overrides.size} override(s)\n`);
    }
  }

  // Create tasks
  await createTasksFromReviews(finalReviews, apiKey, workspaceId);
}

