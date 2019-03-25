const Influx = require('influx');
const prometheus = require('prom-client');
const express = require('express');
const app = express();

const {
	REPLICATOR_PRIMARY_HOST,
	REPLICATOR_PRIMARY_PORT,
	REPLICATOR_PRIMARY_PROTO,
	REPLICATOR_PRIMARY_DATABASE,
	REPLICATOR_PRIMARY_USERNAME,
	REPLICATOR_PRIMARY_PASSWORD,
	REPLICATOR_SECONDARY_HOST,
	REPLICATOR_SECONDARY_PORT,
	REPLICATOR_SECONDARY_PROTO,
	REPLICATOR_SECONDARY_DATABASE,
	REPLICATOR_SECONDARY_USERNAME,
	REPLICATOR_SECONDARY_PASSWORD,

} = process.env;

const primary = new Influx.InfluxDB({
	host: REPLICATOR_PRIMARY_HOST,
	port: REPLICATOR_PRIMARY_PORT,
	database: REPLICATOR_PRIMARY_DATABASE,
	username: REPLICATOR_PRIMARY_USERNAME,
	password: REPLICATOR_PRIMARY_PASSWORD,
	protocol: REPLICATOR_PRIMARY_PROTO,
});

const secondary = new Influx.InfluxDB({
	host: REPLICATOR_SECONDARY_HOST,
	port: REPLICATOR_SECONDARY_PORT,
	database: REPLICATOR_SECONDARY_DATABASE,
	username: REPLICATOR_SECONDARY_USERNAME,
	password: REPLICATOR_SECONDARY_PASSWORD,
	protocol: REPLICATOR_SECONDARY_PROTO,
});

const synchronizedEntries = new prometheus.Counter({
	name: 'influx_replication_synchronized_entries',
	help: 'Counter of synchronized entries'
});

const lastSyncTime = new prometheus.Gauge({
	name: 'last_sync_time',
	help: 'Timestamp of the last successful sync'
});

let lastSyncTimeRaw = 0;

const errorCount = new prometheus.Counter({
	name: 'influx_replication_error_count',
	help: 'Counter of error events'
});

const primaryTime = new prometheus.Gauge({
	name: 'influx_replication_primary_time',
	help: 'Time of the last primary entry',
	labelNames: ['measurement']
});

const secondaryTime = new prometheus.Gauge({
	name: 'influx_replication_secondary_time',
	help: 'Time of the last secondary entry',
	labelNames: ['measurement']
});

const flatten = list => list.reduce(
	(a, b) => a.concat(Array.isArray(b) ? flatten(b) : b), []
);

Array.prototype.flatMap = function (cb, thisArg) {
	const modArr = this.map(cb, thisArg);
	return flatten(modArr);
};

prometheus.collectDefaultMetrics({timeout: 1000});

async function sync() {
	let timeout = 60000;
	try {
		const measurements = await primary.getMeasurements(REPLICATOR_PRIMARY_DATABASE);

		let syncedEntries = 0;
		for (let m of measurements) {
			try {
				const series = await primary.getSeries({
					measurement: m,
					database: REPLICATOR_PRIMARY_DATABASE
				});
				const tags = series
					.flatMap(line => line.split(/,/g).slice(1)
						.map(tags => tags.split(/=/g)[0])
					).reduce((prev, cur) => {
						if (prev.findIndex(item => item === cur) !== -1) {
							return prev;
						}
						return [...prev, cur];
					}, []);

				const lastPrimary = await primary.query(`SELECT * FROM ${m} ORDER BY time DESC LIMIT 1`);
				const fields = Object.keys(lastPrimary[0])
					.filter(key => !tags.find(t => t === key))
					.filter(val => val !== 'time');

				let lastSecondary = (await secondary.query(`SELECT last(${fields[0]}) FROM ${m}`));
				if (lastSecondary.length === 0) {
					lastSecondary = [{time: Influx.toNanoDate('0')}];
				}

				console.log('Measurement', m, 'Last primary', lastPrimary[0].time.toNanoISOString(), 'Last secondary', lastSecondary[0].time.toNanoISOString());

				primaryTime.set({measurement: m}, Number.parseInt(lastPrimary[0].time.getNanoTime()) / 1000);
				secondaryTime.set({measurement: m}, Number.parseInt(lastSecondary[0].time.getNanoTime()) / 1000);

				syncedEntries += await replicate(lastSecondary[0].time, m, tags, fields);
			} catch (e) {
				errorCount.inc();
				console.log('Error during measurement export', e)
			}
		}

		synchronizedEntries.inc(syncedEntries);

		if (syncedEntries > 0) {
			timeout = 1000;
		}

		lastSyncTime.setToCurrentTime();
		lastSyncTimeRaw = new Date();
	} catch (e) {
		errorCount.inc();
		console.log('Error during getting measurements', e);
	}

	setTimeout(sync, timeout);
}

function extractKeys(point, keys) {
	let retTags = {};
	for (let t of keys) {
		if (point[t] !== null && point[t] !== undefined) {
			retTags[t] = point[t];
		}
	}
	return retTags;
}

async function replicate(lastSync, measurement, tags, fields) {
	const data = await primary.query(`SELECT * FROM ${measurement} WHERE time > ${lastSync.getNanoTime()} ORDER BY time ASC LIMIT 5000`);
	if (data.length === 0) {
		return 0;
	}

	console.log('Syncing', data.length, 'entries');

	const sendData = data.map(point => ({
		tags: extractKeys(point, tags),
		fields: extractKeys(point, fields),
		timestamp: point.time
	}));
	try {
		await secondary.writeMeasurement(measurement, sendData);

	} catch (e) {
		errorCount.inc();
		console.log('Replication error', e.message);
	}
	return data.length;
}

function checkAlive() {
	if(((new Date()) - lastSyncTimeRaw) > 5*60*1000) {
		console.log('No Sync for 5 minutes');
		process.exit(1);
	}
}

(async function () {
	setTimeout(sync, 0);
	setInterval(checkAlive, 5*60*1000);
})();

app.get('/metrics', (req, res) => {
	res.set('Content-Type', prometheus.register.contentType);
	res.end(prometheus.register.metrics())
});

app.listen(3000);

//primary.query("SELECT * FROM carpark_status;").then(result => console.log(result.length, result[0]));
