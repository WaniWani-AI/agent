import { readFile, writeFile } from "node:fs/promises";

// Model steps hold Graphile worker slots until generation ends. Give workflow
// replays and Eve's cancellation-forwarding step their own reserved capacity;
// merely increasing the shared concurrency postpones the same deadlock.
// This is coupled to Eve 0.53.0's cancellation path and the inline-step opt-out.
const root = new URL("../node_modules/@workflow/world-postgres/", import.meta.url);
const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
if (version !== "5.0.0-beta.40") {
	throw new Error(`Review the cancellation worker patch before using Postgres World ${version}`);
}
const path = new URL("dist/queue.js", root);
let source = await readFile(path, "utf8");
const replacements = [
	[
		"await utils.addJob(getJobQueueName(), MessageData.encode({",
		`const invocation = WorkflowInvokePayloadSchema.safeParse(await deserializeMessageBody(body));
        const isControl = invocation.success && (!invocation.data.stepId ||
            invocation.data.stepName === 'step//eve@0.53.0//forwardTurnCancellationStep');
        const task = getJobQueueName() + (isControl ? '_control' : '');
        await utils.addJob(task, MessageData.encode({`,
	],
	[
		"taskList[getJobQueueName()] = createTaskHandler(workflowPrefix);",
		`taskList[getJobQueueName()] = createTaskHandler(workflowPrefix);
        const controlTask = getJobQueueName() + '_control';
        taskList[controlTask] = taskList[getJobQueueName()];`,
	],
	[
		"runner = await run({",
		"const workRunner = await run({",
	],
	[
		`            taskList,
        });
    }
    return {`,
		`            taskList,
        });
        try {
            const controlRunner = await run({
                pgPool: pool,
                concurrency: 2,
                logger: graphileLogger,
                ...(config.applicationManagedShutdown === true && { noHandleSignals: true }),
                pollInterval: 500,
                taskList: { [controlTask]: taskList[controlTask] },
            });
            runner = {
                stop: () => Promise.all([workRunner.stop(), controlRunner.stop()]),
                promise: Promise.all([workRunner.promise, controlRunner.promise]),
            };
        } catch (error) {
            await workRunner.stop();
            throw error;
        }
    }
    return {`,
	],
];
for (const [original, patched] of replacements) {
	if (source.includes(patched)) continue;
	if (source.split(original).length !== 2) {
		throw new Error("Postgres queue implementation changed; review the cancellation worker patch");
	}
	source = source.replace(original, patched);
}
await writeFile(path, source);
