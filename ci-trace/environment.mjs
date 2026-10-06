/**
 * What a build ran on, so build times can be compared across machines, pools,
 * client infra, and tool versions. Collected once at the end of the build and
 * attached to the root span. Every lookup is best-effort with a short timeout;
 * anything unavailable (e.g. no metadata server outside GCP) is just left out.
 */

import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// https://cloud.google.com/compute/docs/metadata/predefined-metadata-keys
const metadata = async (path) => {
	try {
		const response = await fetch(`http://metadata.google.internal/computeMetadata/v1/${path}`, {
			headers: { "Metadata-Flavor": "Google" },
			signal: AbortSignal.timeout(1000),
		});
		return response.ok ? (await response.text()).trim() : undefined;
	}
	catch {
		return undefined;
	}
};

const run = async (command, args) => {
	try {
		return (await execFileP(command, args, { timeout: 5000 })).stdout.trim();
	}
	catch {
		return undefined;
	}
};

// metadata returns e.g. projects/123/zones/us-central1-f; we want the last part
const lastSegment = (value) => value?.split("/").at(-1);

export const collectEnvironment = async () => {
	const [ machineType, instanceName, zone, vmProjectId, vmProjectNumber, dockerVersions, buildxVersion ] = await Promise.all([
		metadata("instance/machine-type"),
		metadata("instance/name"),
		metadata("instance/zone"),
		metadata("project/project-id"),
		metadata("project/numeric-project-id"),
		run("docker", [ "version", "--format", "{{.Client.Version}} {{.Server.Version}}" ]),
		run("docker", [ "buildx", "version" ]),
	]);
	const availabilityZone = lastSegment(zone);
	const [ dockerClient, dockerServer ] = dockerVersions?.split(" ") ?? [];
	const cpus = os.cpus();

	return {
		// machine. In a Cloud Build step the container hostname is usually a random id;
		// the VM name is more telling there, and on self-hosted machines host.name is.
		"host.name": os.hostname(),
		"gcp.gce.instance.name": instanceName,
		"host.type": lastSegment(machineType),
		"host.arch": os.arch(),
		"host.cpu.count": cpus.length,
		"host.cpu.model.name": cpus[0]?.model,
		"host.memory.total_bytes": os.totalmem(),
		"os.version": os.release(),

		// where it ran. The VM's project is Google's on the default pool and the pool's
		// on a private pool, so compare it with ci.project.id (the build's project).
		"cloud.provider": machineType ? "gcp" : undefined,
		"cloud.availability_zone": availabilityZone,
		"cloud.region": availabilityZone?.replace(/-[a-z]$/, ""),
		"cloud.account.id": vmProjectId,
		"gcp.project.number": vmProjectNumber,

		// tooling
		"ci_builder.version": process.env.CI_BUILDER_VERSION,
		"process.runtime.version": process.version,
		"docker.client.version": dockerClient,
		"docker.server.version": dockerServer,
		// "github.com/docker/buildx v0.17.1 1234abc" -> "v0.17.1"
		"docker.buildx.version": buildxVersion?.match(/v\d\S*/)?.[0],
	};
};
