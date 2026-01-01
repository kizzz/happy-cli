import chalk from 'chalk';
import { readCredentials, type Credentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import { JobClient } from '@/api/jobClient';
import { encodeBase64, encrypt } from '@/api/encryption';

/**
 * Handle job subcommand
 * 
 * Implements job subcommands for managing on-demand work:
 * - job create: Create a new job
 * - job list: List jobs
 * - job get <jobId>: Get job details
 * - job cancel <jobId>: Cancel a job
 * - job help: Show help for job command
 */
export async function handleJobCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showJobHelp();
        return;
    }

    const credentials = await readCredentials();
    if (!credentials) {
        console.error(chalk.red('Not authenticated. Please run: happy auth login'));
        process.exit(1);
    }

    const api = await ApiClient.create(credentials);
    
    // Get encryption key from credentials
    let encryptionKey: Uint8Array;
    if (credentials.encryption.type === 'legacy') {
        encryptionKey = credentials.encryption.secret;
    } else {
        // For dataKey type, we'd need to decrypt the data key
        // For now, throw error as this is not fully implemented
        throw new Error('Data key encryption not yet supported for job commands');
    }

    const jobClient = new JobClient(credentials.token);

    switch (subcommand.toLowerCase()) {
        case 'create':
            await handleJobCreate(args.slice(1), credentials, encryptionKey);
            break;
        case 'list':
            await handleJobList(args.slice(1), jobClient);
            break;
        case 'get':
            await handleJobGet(args.slice(1), jobClient);
            break;
        case 'cancel':
            await handleJobCancel(args.slice(1), jobClient);
            break;
        default:
            console.error(chalk.red(`Unknown job subcommand: ${subcommand}`));
            showJobHelp();
            process.exit(1);
    }
}

async function handleJobCreate(
    args: string[],
    credentials: any,
    encryptionKey: Uint8Array
): Promise<void> {
    // Parse arguments
    // Format: job create --type codex --input "prompt" [--config {...}] [--priority 0] [--machine-id <id>]
    let type: 'claude' | 'codex' | null = null;
    let input: string | null = null;
    let config: any = {};
    let priority = 0;
    let machineId: string | undefined = undefined;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--type' && args[i + 1]) {
            type = args[i + 1] as 'claude' | 'codex';
            i++;
        } else if (args[i] === '--input' && args[i + 1]) {
            input = args[i + 1];
            i++;
        } else if (args[i] === '--config' && args[i + 1]) {
            try {
                config = JSON.parse(args[i + 1]);
            } catch (e) {
                console.error(chalk.red(`Invalid JSON in --config: ${args[i + 1]}`));
                process.exit(1);
            }
            i++;
        } else if (args[i] === '--priority' && args[i + 1]) {
            priority = parseInt(args[i + 1], 10);
            if (isNaN(priority)) {
                console.error(chalk.red(`Invalid priority: ${args[i + 1]}`));
                process.exit(1);
            }
            i++;
        } else if (args[i] === '--machine-id' && args[i + 1]) {
            machineId = args[i + 1];
            i++;
        }
    }

    if (!type) {
        console.error(chalk.red('--type is required (codex or claude)'));
        process.exit(1);
    }

    if (!input) {
        console.error(chalk.red('--input is required'));
        process.exit(1);
    }

    // Encrypt config and input
    const encryptedConfig = encodeBase64(encrypt(encryptionKey, 'legacy', config));
    const encryptedInput = encodeBase64(encrypt(encryptionKey, 'legacy', input));

    try {
        const jobClient = new JobClient(credentials.token);
        const response = await jobClient.createJob({
            type,
            config: encryptedConfig,
            input: encryptedInput,
            priority,
            machineId
        });

        console.log(chalk.green(`Job created: ${response.job.id}`));
        console.log(`Status: ${response.job.status}`);
        console.log(`Type: ${response.job.type}`);
    } catch (error) {
        console.error(chalk.red('Failed to create job:'), error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
    }
}

async function handleJobList(args: string[], jobClient: JobClient): Promise<void> {
    // Parse arguments
    // Format: job list [--status pending|running|completed|failed] [--limit 10]
    let status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | undefined = undefined;
    let limit = 10;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--status' && args[i + 1]) {
            status = args[i + 1] as any;
            i++;
        } else if (args[i] === '--limit' && args[i + 1]) {
            limit = parseInt(args[i + 1], 10);
            if (isNaN(limit) || limit < 1) {
                console.error(chalk.red(`Invalid limit: ${args[i + 1]}`));
                process.exit(1);
            }
            i++;
        }
    }

    try {
        const response = await jobClient.listJobs({ status, limit });

        if (response.jobs.length === 0) {
            console.log('No jobs found');
            return;
        }

        console.log(`Found ${response.jobs.length} job(s):\n`);
        for (const job of response.jobs) {
            console.log(`${job.id}`);
            console.log(`  Type: ${job.type}`);
            console.log(`  Status: ${job.status}`);
            console.log(`  Priority: ${job.priority}`);
            if (job.machineId) {
                console.log(`  Machine: ${job.machineId}`);
            }
            console.log(`  Created: ${new Date(job.createdAt).toISOString()}`);
            console.log('');
        }
    } catch (error) {
        console.error(chalk.red('Failed to list jobs:'), error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
    }
}

async function handleJobGet(args: string[], jobClient: JobClient): Promise<void> {
    const jobId = args[0];

    if (!jobId) {
        console.error(chalk.red('Job ID is required'));
        console.log('Usage: happy job get <jobId>');
        process.exit(1);
    }

    try {
        const response = await jobClient.getJob(jobId);
        const job = response.job;

        console.log(`Job: ${job.id}`);
        console.log(`  Type: ${job.type}`);
        console.log(`  Status: ${job.status}`);
        console.log(`  Priority: ${job.priority}`);
        if (job.machineId) {
            console.log(`  Machine: ${job.machineId}`);
        }
        if (job.sessionId) {
            console.log(`  Session: ${job.sessionId}`);
        }
        console.log(`  Created: ${new Date(job.createdAt).toISOString()}`);
        console.log(`  Updated: ${new Date(job.updatedAt).toISOString()}`);
        if (job.startedAt) {
            console.log(`  Started: ${new Date(job.startedAt).toISOString()}`);
        }
        if (job.completedAt) {
            console.log(`  Completed: ${new Date(job.completedAt).toISOString()}`);
        }
    } catch (error) {
        console.error(chalk.red('Failed to get job:'), error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
    }
}

async function handleJobCancel(args: string[], jobClient: JobClient): Promise<void> {
    const jobId = args[0];

    if (!jobId) {
        console.error(chalk.red('Job ID is required'));
        console.log('Usage: happy job cancel <jobId>');
        process.exit(1);
    }

    try {
        await jobClient.cancelJob(jobId);
        console.log(chalk.green(`Job ${jobId} cancelled`));
    } catch (error) {
        console.error(chalk.red('Failed to cancel job:'), error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
    }
}

function showJobHelp(): void {
    console.log(chalk.bold('Job Commands'));
    console.log('');
    console.log('Manage on-demand work jobs');
    console.log('');
    console.log('Usage:');
    console.log('  happy job <subcommand> [options]');
    console.log('');
    console.log('Subcommands:');
    console.log('  create              Create a new job');
    console.log('  list                List jobs');
    console.log('  get <jobId>         Get job details');
    console.log('  cancel <jobId>      Cancel a job');
    console.log('  help                Show this help message');
    console.log('');
    console.log('Examples:');
    console.log('  happy job create --type codex --input "Write a hello world program"');
    console.log('  happy job list --status pending');
    console.log('  happy job get abc123');
    console.log('  happy job cancel abc123');
}

