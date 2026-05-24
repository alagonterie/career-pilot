import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import { getDb } from './db';

const execPromise = util.promisify(exec);

const DATA_DIR = path.resolve(__dirname, '../../data');
const TASKS_DIR = path.join(DATA_DIR, 'tasks');
const RESULTS_DIR = path.join(DATA_DIR, 'results');

export async function runAgentContainer(taskId: number, agentName: string, inputData: any): Promise<any> {
  // Ensure folders exist
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const inputPath = path.join(TASKS_DIR, `${taskId}.json`);
  const resultsPath = path.join(RESULTS_DIR, `${taskId}.json`);

  // Write input JSON to task file
  fs.writeFileSync(inputPath, JSON.stringify(inputData, null, 2));

  // Determine host paths for mounting inside Docker.
  // When running inside a docker container itself (e.g. backend service),
  // path mounts reference the HOST filesystem.
  // In our docker-compose configurations, we mount `./data` to `/app/data` (dev)
  // or `/home/app/data` to `/app/data` (prod).
  // Thus, the host path for the mounted folders is:
  const isProduction = process.env.ENVIRONMENT === 'production';
  const hostDataDir = isProduction ? '/home/app/data' : path.resolve(process.cwd(), 'data');
  const hostInputPath = path.join(hostDataDir, 'tasks', `${taskId}.json`);
  const hostResultsDir = path.join(hostDataDir, 'results');

  // Build the Docker run command.
  // Mount the input file to /input.json (read-only) and results dir to /results
  const command = `docker run --rm \
    -v "${hostInputPath}:/input.json:ro" \
    -v "${hostResultsDir}:/results" \
    --network="host" \
    "career-pilot-agent-${agentName}:latest"`;

  console.log(`[Task ${taskId}] Launching agent container: ${command}`);

  try {
    const { stdout, stderr } = await execPromise(command);
    console.log(`[Task ${taskId}] Container stdout:\n${stdout}`);
    if (stderr) console.error(`[Task ${taskId}] Container stderr:\n${stderr}`);

    // Read the results file
    if (fs.existsSync(resultsPath)) {
      const resultsRaw = fs.readFileSync(resultsPath, 'utf8');
      const results = JSON.parse(resultsRaw);

      // Clean up results file from disk
      fs.unlinkSync(resultsPath);
      return results;
    } else {
      throw new Error(`Results file not found at ${resultsPath}`);
    }
  } catch (error) {
    console.error(`[Task ${taskId}] Execution failed:`, error);
    throw error;
  } finally {
    // Clean up input task file
    if (fs.existsSync(inputPath)) {
      fs.unlinkSync(inputPath);
    }
  }
}

// Host Task Loop: Polls database for pending tasks and runs them
let isPolling = false;

export async function startTaskOrchestrator() {
  if (isPolling) return;
  isPolling = true;

  console.log('Task Orchestrator loop started.');

  // Run the loop every 10 seconds
  setInterval(async () => {
    try {
      const db = await getDb();
      
      // Get the next pending task
      const task = await db.get(
        `SELECT * FROM agent_tasks WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 1`
      );

      if (task) {
        console.log(`[Orchestrator] Found pending task ${task.id} for agent ${task.agent_name}`);

        // Update task to RUNNING
        await db.run(
          `UPDATE agent_tasks SET status = 'RUNNING', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [task.id]
        );

        const inputData = JSON.parse(task.input_data || '{}');

        // Run the agent container
        runAgentContainer(task.id, task.agent_name, inputData)
          .then(async (outputData) => {
            // Update task to COMPLETED
            await db.run(
              `UPDATE agent_tasks 
               SET status = 'COMPLETED', output_data = ?, updated_at = CURRENT_TIMESTAMP 
               WHERE id = ?`,
              [JSON.stringify(outputData), task.id]
            );
            console.log(`[Orchestrator] Task ${task.id} completed successfully.`);
          })
          .catch(async (error: any) => {
            // Update task to FAILED
            await db.run(
              `UPDATE agent_tasks 
               SET status = 'FAILED', output_data = ?, updated_at = CURRENT_TIMESTAMP 
               WHERE id = ?`,
              [JSON.stringify({ error: error.message }), task.id]
            );
            console.error(`[Orchestrator] Task ${task.id} failed.`);
          });
      }
    } catch (err) {
      console.error('[Orchestrator] Error in polling loop:', err);
    }
  }, 10000);
}
