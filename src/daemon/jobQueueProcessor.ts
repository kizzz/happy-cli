/**
 * Job Queue Processor
 * 
 * Polls the server for pending jobs assigned to this machine and executes them.
 * Manages concurrent job execution limits and handles job lifecycle.
 */

import { logger } from '@/ui/logger';
import { JobClient } from '@/api/jobClient';
import { Credentials } from '@/persistence';
import { executeJob } from './jobExecutor';
import type { Job } from '@/api/jobClient';

export interface JobQueueProcessorOptions {
    credentials: Credentials;
    machineId: string;
    pollIntervalMs?: number;
    maxConcurrentJobs?: number;
}

/**
 * Job Queue Processor
 */
export class JobQueueProcessor {
    private isRunning = false;
    private pollInterval: NodeJS.Timeout | null = null;
    private runningJobs = new Set<string>(); // Set of job IDs currently executing
    private jobClient: JobClient;
    private credentials: Credentials;
    private machineId: string;
    private maxConcurrentJobs: number;

    constructor(options: JobQueueProcessorOptions) {
        this.credentials = options.credentials;
        this.machineId = options.machineId;
        this.maxConcurrentJobs = options.maxConcurrentJobs || 3;
        
        // Create JobClient with token from credentials
        this.jobClient = new JobClient(options.credentials.token);
    }

    /**
     * Start polling for jobs
     */
    start(): void {
        if (this.isRunning) {
            logger.debug('[JobQueueProcessor] Already running');
            return;
        }

        this.isRunning = true;
        const pollIntervalMs = 5000; // Poll every 5 seconds

        logger.debug(`[JobQueueProcessor] Starting job queue processor for machine ${this.machineId}`);

        // Poll immediately, then set interval
        this.pollAndExecuteJobs();

        this.pollInterval = setInterval(() => {
            this.pollAndExecuteJobs();
        }, pollIntervalMs);
    }

    /**
     * Stop polling for jobs
     */
    stop(): void {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;

        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }

        logger.debug('[JobQueueProcessor] Stopped job queue processor');
    }

    /**
     * Poll server for pending jobs and execute them
     */
    private async pollAndExecuteJobs(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        // Check if we have capacity for more jobs
        if (this.runningJobs.size >= this.maxConcurrentJobs) {
            logger.debug(`[JobQueueProcessor] Max concurrent jobs reached (${this.runningJobs.size}/${this.maxConcurrentJobs})`);
            return;
        }

        try {
            // Get pending jobs for this machine
            const response = await this.jobClient.getPendingJobsForMachine(
                this.machineId,
                this.maxConcurrentJobs - this.runningJobs.size
            );

            const availableSlots = this.maxConcurrentJobs - this.runningJobs.size;
            const jobsToExecute = response.jobs.slice(0, availableSlots);

            if (jobsToExecute.length === 0) {
                return; // No jobs available
            }

            logger.debug(`[JobQueueProcessor] Found ${jobsToExecute.length} pending jobs`);

            // Execute jobs concurrently (up to maxConcurrentJobs)
            for (const jobSummary of jobsToExecute) {
                // Get full job details
                const jobResponse = await this.jobClient.getJob(jobSummary.id);
                const job = jobResponse.job;

                // Skip if job is no longer pending (could have been cancelled)
                if (job.status !== 'pending' && job.status !== 'queued') {
                    logger.debug(`[JobQueueProcessor] Skipping job ${job.id} - status is ${job.status}`);
                    continue;
                }

                // Skip if already running
                if (this.runningJobs.has(job.id)) {
                    continue;
                }

            // Check capacity before executing
            if (this.runningJobs.size >= this.maxConcurrentJobs) {
                break; // No more capacity
            }

            // Execute job asynchronously
            this.executeJobAsync(job).catch((error) => {
                logger.debug(`[JobQueueProcessor] Error executing job ${job.id}:`, error);
            });
            }
        } catch (error) {
            logger.debug('[JobQueueProcessor] Error polling for jobs:', error);
        }
    }

    /**
     * Execute a job asynchronously
     */
    private async executeJobAsync(job: Job): Promise<void> {
        // Mark job as running
        this.runningJobs.add(job.id);

        try {
            logger.debug(`[JobQueueProcessor] Starting execution of job ${job.id}`);

            // Execute the job (executor handles status updates)
            await executeJob({
                job,
                credentials: this.credentials,
                machineId: this.machineId,
                timeoutMs: 30 * 60 * 1000 // 30 minutes default timeout
            });

            logger.debug(`[JobQueueProcessor] Job ${job.id} execution completed`);
        } catch (error) {
            logger.debug(`[JobQueueProcessor] Job ${job.id} execution failed:`, error);
            // Error is handled by executeJob which updates the job status
        } finally {
            // Remove from running jobs
            this.runningJobs.delete(job.id);
        }
    }

    /**
     * Get current status
     */
    getStatus(): {
        isRunning: boolean;
        runningJobsCount: number;
        maxConcurrentJobs: number;
    } {
        return {
            isRunning: this.isRunning,
            runningJobsCount: this.runningJobs.size,
            maxConcurrentJobs: this.maxConcurrentJobs
        };
    }
}

