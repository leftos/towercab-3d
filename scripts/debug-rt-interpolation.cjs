#!/usr/bin/env node
/**
 * Debug script for RealTraffic aircraft tracking
 *
 * Polls RealTraffic API around KSFO, tracks selected aircraft with non-zero speed,
 * and logs snapshots to help debug interpolation issues (pausing, shuffling, jumping).
 *
 * Usage: node scripts/debug-rt-interpolation.js
 */

const https = require('https');
const querystring = require('querystring');

// Configuration
const LICENSE_KEY = 'MHNWJ-L4IH-KJKQPY-ILCB4Y';
const API_BASE = 'https://rtwa.flyrealtraffic.com/v5';
const CENTER_LAT = 33.9425;  // KLAX
const CENTER_LON = -118.4081;
const RADIUS_NM = 40;  // Larger radius for busy airport

// Calculate bounding box
const NM_TO_DEGREES = 1 / 60;
const latOffset = RADIUS_NM * NM_TO_DEGREES;
const lonOffset = RADIUS_NM * NM_TO_DEGREES / Math.cos(CENTER_LAT * Math.PI / 180);

const BBOX = {
  latMin: CENTER_LAT - latOffset,
  latMax: CENTER_LAT + latOffset,
  lonMin: CENTER_LON - lonOffset,
  lonMax: CENTER_LON + lonOffset
};

// State
let sessionGuid = null;
let trafficRateLimit = 3000;  // ms, will be updated from API
let trackedAircraft = new Map();  // hexid -> { snapshots: [], callsign, type }
const MAX_SNAPSHOTS = 30;
const TARGET_AIRCRAFT_COUNT = 20;  // Track more aircraft for better sample

/**
 * Make HTTPS POST request with form data
 */
function postForm(url, formData) {
  return new Promise((resolve, reject) => {
    const data = querystring.stringify(formData);
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        'Accept-Encoding': 'identity'  // Don't use gzip for simplicity
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${body.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Authenticate with RealTraffic API
 */
async function authenticate() {
  console.log('Authenticating with RealTraffic API...');

  const response = await postForm(`${API_BASE}/auth`, {
    license: LICENSE_KEY,
    software: 'TowerCab3D-Debug'
  });

  if (response.status !== 200) {
    throw new Error(`Authentication failed: ${response.message || 'Unknown error'}`);
  }

  sessionGuid = response.GUID;
  trafficRateLimit = Math.max(response.rrl || 3000, 1000);

  const isPro = response.type === 2;
  console.log(`Authenticated! GUID: ${sessionGuid.substring(0, 8)}...`);
  console.log(`License: ${isPro ? 'Pro' : 'Standard'}, Rate limit: ${trafficRateLimit}ms`);

  return response;
}

/**
 * Fetch traffic data
 */
async function fetchTraffic() {
  const response = await postForm(`${API_BASE}/traffic`, {
    GUID: sessionGuid,
    querytype: 'locationtraffic',
    top: BBOX.latMax.toString(),
    bottom: BBOX.latMin.toString(),
    left: BBOX.lonMin.toString(),
    right: BBOX.lonMax.toString()
  });

  if (response.status && response.status !== 200) {
    throw new Error(`Traffic fetch failed: ${response.message || `Status ${response.status}`}`);
  }

  // Update rate limit from response
  if (response.rrl) {
    trafficRateLimit = Math.max(response.rrl, 1000);
  }

  return response;
}

/**
 * Parse raw record array to object
 * Indices from RealTraffic API v5 (from docs page 11):
 * [0] hexid, [1] lat, [2] lon, [3] track, [4] baro_alt, [5] gs,
 * [6] squawk, [7] source, [8] type, [9] tail, [10] timestamp,
 * [11] from_iata, [12] to_iata, [13] cs_icao, [14] on_ground,
 * [15] baro_rate, [16] cs_iata, [17] msg_type, [18] alt_geom,
 * [19] IAS, [20] TAS, [21] Mach, [22] track_rate, [23] roll,
 * [24] mag_heading, [25] true_heading, [26] geom_rate, [27] emergency,
 * [28] category, [29] nav_qnh, [30] mcp_alt, [31] fms_alt,
 * [32] selected_heading, [33] nav_modes, [34] NIC, [35] RC,
 * [36] NIC_baro, [37] NAC_p, [38] NAC_v, [39] seen/age,
 * [40] rssi, [41] alert, [42] spi, [43] wind_dir, [44] wind_spd
 */
function parseRecord(record) {
  return {
    hexid: String(record[0] ?? ''),
    lat: Number(record[1]) || 0,
    lon: Number(record[2]) || 0,
    track: Number(record[3]) || 0,
    altitude: Number(record[4]) || 0,  // baro_alt in feet
    groundspeed: Number(record[5]) || 0,  // knots
    squawk: String(record[6] ?? ''),
    source: String(record[7] ?? ''),  // data source/provider
    type: String(record[8] ?? ''),
    tail: String(record[9] ?? ''),
    apiTimestamp: Number(record[10]) || 0,  // Unix timestamp from API
    callsign: String(record[13] ?? '') || String(record[9] ?? ''),  // cs_icao or tail
    onGround: record[14] != null ? Number(record[14]) : null,
    baroRate: record[15] != null ? Number(record[15]) : null,  // fpm
    msgType: String(record[17] ?? ''),  // message source type
    trackRate: record[22] != null ? Number(record[22]) : null,  // deg/s, negative = left
    roll: record[23] != null ? Number(record[23]) : null,  // degrees, negative = left
    magHeading: record[24] != null ? Number(record[24]) : null,
    trueHeading: record[25] != null ? Number(record[25]) : null,
    geomRate: record[26] != null ? Number(record[26]) : null,  // geometric vertical rate
    positionAge: record[39] != null ? Number(record[39]) : null,  // seconds since last ADS-B update
    rssi: record[40] != null ? Number(record[40]) : null  // signal strength
  };
}

/**
 * Select interesting aircraft to track (non-zero speed, preferably moving)
 */
function selectAircraftToTrack(data) {
  const candidates = [];

  for (const [hexid, record] of Object.entries(data || {})) {
    const parsed = parseRecord(record);

    // Skip if no groundspeed or very slow
    if (parsed.groundspeed < 20) continue;

    // Prefer aircraft that are:
    // 1. Moving fast (likely in air or taking off)
    // 2. Have a callsign
    // 3. Have position age available (good ADS-B coverage)

    candidates.push({
      hexid,
      ...parsed,
      score: parsed.groundspeed + (parsed.callsign ? 50 : 0) + (parsed.positionAge !== null ? 20 : 0)
    });
  }

  // Sort by score descending and take top N
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, TARGET_AIRCRAFT_COUNT);
}

/**
 * Main polling loop
 */
async function pollLoop() {
  let pollCount = 0;

  while (true) {
    try {
      const now = Date.now();
      const response = await fetchTraffic();
      const fetchTime = Date.now();

      pollCount++;

      // On first poll or if we have no tracked aircraft, select some
      if (trackedAircraft.size === 0 && response.data) {
        const selected = selectAircraftToTrack(response.data);
        console.log(`\n=== Selected ${selected.length} aircraft to track ===`);

        for (const ac of selected) {
          trackedAircraft.set(ac.hexid, {
            callsign: ac.callsign,
            type: ac.type,
            snapshots: []
          });
          console.log(`  ${ac.callsign || ac.hexid} (${ac.type}) - ${ac.groundspeed.toFixed(0)}kts @ ${ac.altitude}ft`);

          // Dump raw record for first aircraft to see field positions
          if (trackedAircraft.size === 1) {
            const rawRecord = response.data[ac.hexid];
            console.log(`\n=== RAW RECORD for ${ac.callsign} ===`);
            for (let i = 0; i < rawRecord.length; i++) {
              const val = rawRecord[i];
              const valStr = val === null ? 'null' : val === '' ? '""' : String(val);
              console.log(`  [${i.toString().padStart(2)}] ${valStr}`);
            }
            console.log('');
          }
        }
        console.log('');
      }

      // Update tracked aircraft with new data
      let updatedCount = 0;
      let missingCount = 0;

      for (const [hexid, tracking] of trackedAircraft) {
        const record = response.data?.[hexid];

        if (record) {
          const parsed = parseRecord(record);
          const snapshot = {
            pollTime: now,
            fetchTime: fetchTime,
            localTimestamp: now,
            apiTimestamp: parsed.apiTimestamp,
            positionAge: parsed.positionAge,
            lat: parsed.lat,
            lon: parsed.lon,
            altitude: parsed.altitude,
            groundspeed: parsed.groundspeed,
            track: parsed.track,
            trueHeading: parsed.trueHeading,
            magHeading: parsed.magHeading,
            trackRate: parsed.trackRate,
            roll: parsed.roll,
            onGround: parsed.onGround,
            baroRate: parsed.baroRate,
            geomRate: parsed.geomRate,
            source: parsed.source,
            msgType: parsed.msgType
          };

          tracking.snapshots.push(snapshot);

          // Keep only last N snapshots
          if (tracking.snapshots.length > MAX_SNAPSHOTS) {
            tracking.snapshots.shift();
          }

          updatedCount++;
        } else {
          missingCount++;
        }
      }

      // Log summary
      const totalAircraft = Object.keys(response.data || {}).length;
      console.log(`Poll #${pollCount}: ${totalAircraft} total aircraft, ${updatedCount} tracked updated, ${missingCount} missing`);

      // Every 5 polls, print detailed analysis
      if (pollCount % 5 === 0) {
        printAnalysis();
      }

      // Wait for rate limit AFTER the response is received
      // This matches how the app's store does it - measure from after fetch completes
      console.log(`  Waiting ${trafficRateLimit}ms (rate limit)...`);
      await sleep(trafficRateLimit);

    } catch (error) {
      console.error('Poll error:', error.message);

      // If session expired, re-authenticate
      if (error.message.includes('401') || error.message.includes('Session')) {
        console.log('Session expired, re-authenticating...');
        await authenticate();
      }

      await sleep(5000);  // Wait before retry
    }
  }
}

/**
 * Print analysis of tracked aircraft
 */
function printAnalysis() {
  console.log('\n=== AIRCRAFT ANALYSIS ===');

  // Collect all apiDelta values for summary statistics
  const allApiDeltas = [];
  const allPositionAges = [];

  for (const [hexid, tracking] of trackedAircraft) {
    const { callsign, type, snapshots } = tracking;

    if (snapshots.length < 2) {
      continue;
    }

    // Collect apiDeltas for this aircraft
    for (let i = 1; i < snapshots.length; i++) {
      const snap = snapshots[i];
      const prev = snapshots[i - 1];
      const apiDelta = snap.apiTimestamp - prev.apiTimestamp;
      if (apiDelta > 0 && apiDelta < 30) {  // Filter out anomalies
        allApiDeltas.push(apiDelta);
      }
      if (snap.positionAge !== null) {
        allPositionAges.push(snap.positionAge);
      }
    }
  }

  // Print summary statistics
  if (allApiDeltas.length > 0) {
    allApiDeltas.sort((a, b) => a - b);
    const min = allApiDeltas[0];
    const max = allApiDeltas[allApiDeltas.length - 1];
    const median = allApiDeltas[Math.floor(allApiDeltas.length / 2)];
    const avg = allApiDeltas.reduce((a, b) => a + b, 0) / allApiDeltas.length;
    const p10 = allApiDeltas[Math.floor(allApiDeltas.length * 0.1)];
    const p90 = allApiDeltas[Math.floor(allApiDeltas.length * 0.9)];

    console.log('\n=== API DELTA STATISTICS (seconds between ADS-B observations) ===');
    console.log(`  Samples: ${allApiDeltas.length}`);
    console.log(`  Min: ${min.toFixed(2)}s  Max: ${max.toFixed(2)}s`);
    console.log(`  Avg: ${avg.toFixed(2)}s  Median: ${median.toFixed(2)}s`);
    console.log(`  P10: ${p10.toFixed(2)}s  P90: ${p90.toFixed(2)}s`);

    // Histogram
    console.log('\n  Distribution:');
    const buckets = [0, 0, 0, 0, 0, 0, 0];  // <1s, 1-2s, 2-3s, 3-4s, 4-5s, 5-6s, >6s
    for (const d of allApiDeltas) {
      if (d < 1) buckets[0]++;
      else if (d < 2) buckets[1]++;
      else if (d < 3) buckets[2]++;
      else if (d < 4) buckets[3]++;
      else if (d < 5) buckets[4]++;
      else if (d < 6) buckets[5]++;
      else buckets[6]++;
    }
    const total = allApiDeltas.length;
    console.log(`    <1s:  ${buckets[0].toString().padStart(4)} (${(buckets[0]/total*100).toFixed(1)}%)`);
    console.log(`    1-2s: ${buckets[1].toString().padStart(4)} (${(buckets[1]/total*100).toFixed(1)}%)`);
    console.log(`    2-3s: ${buckets[2].toString().padStart(4)} (${(buckets[2]/total*100).toFixed(1)}%)`);
    console.log(`    3-4s: ${buckets[3].toString().padStart(4)} (${(buckets[3]/total*100).toFixed(1)}%)`);
    console.log(`    4-5s: ${buckets[4].toString().padStart(4)} (${(buckets[4]/total*100).toFixed(1)}%)`);
    console.log(`    5-6s: ${buckets[5].toString().padStart(4)} (${(buckets[5]/total*100).toFixed(1)}%)`);
    console.log(`    >6s:  ${buckets[6].toString().padStart(4)} (${(buckets[6]/total*100).toFixed(1)}%)`);
  }

  if (allPositionAges.length > 0) {
    allPositionAges.sort((a, b) => a - b);
    const min = allPositionAges[0];
    const max = allPositionAges[allPositionAges.length - 1];
    const median = allPositionAges[Math.floor(allPositionAges.length / 2)];
    const avg = allPositionAges.reduce((a, b) => a + b, 0) / allPositionAges.length;
    const p90 = allPositionAges[Math.floor(allPositionAges.length * 0.9)];

    console.log('\n=== POSITION AGE STATISTICS (how old is data when received) ===');
    console.log(`  Samples: ${allPositionAges.length}`);
    console.log(`  Min: ${min.toFixed(2)}s  Max: ${max.toFixed(2)}s`);
    console.log(`  Avg: ${avg.toFixed(2)}s  Median: ${median.toFixed(2)}s  P90: ${p90.toFixed(2)}s`);
  }

  // Print per-aircraft details (abbreviated)
  console.log('\n=== PER-AIRCRAFT SUMMARY ===');
  for (const [hexid, tracking] of trackedAircraft) {
    const { callsign, type, snapshots } = tracking;

    if (snapshots.length < 3) {
      continue;
    }

    const apiDeltas = [];
    const ages = [];
    for (let i = 1; i < snapshots.length; i++) {
      const apiDelta = snapshots[i].apiTimestamp - snapshots[i-1].apiTimestamp;
      if (apiDelta > 0 && apiDelta < 30) apiDeltas.push(apiDelta);
      if (snapshots[i].positionAge !== null) ages.push(snapshots[i].positionAge);
    }

    if (apiDeltas.length > 0) {
      const avgDelta = apiDeltas.reduce((a, b) => a + b, 0) / apiDeltas.length;
      const minDelta = Math.min(...apiDeltas);
      const maxDelta = Math.max(...apiDeltas);
      const avgAge = ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : null;
      const lastSnap = snapshots[snapshots.length - 1];
      const groundStr = lastSnap.onGround === 1 ? ' [GND]' : '';

      console.log(`  ${(callsign || hexid).padEnd(8)} (${type.padEnd(4)}) GS=${lastSnap.groundspeed.toFixed(0).padStart(3)}kts${groundStr} apiΔ: ${minDelta.toFixed(1)}-${maxDelta.toFixed(1)}s (avg ${avgDelta.toFixed(1)}s) age: ${avgAge !== null ? avgAge.toFixed(1) + 's' : '?'}`);
    }
  }

  console.log('\n');
}

/**
 * Analyze patterns in snapshots that might cause interpolation issues
 */
function analyzePatterns(name, snapshots) {
  if (snapshots.length < 3) return;

  const issues = [];

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];

    // Check for stale position (same lat/lon)
    if (Math.abs(curr.lat - prev.lat) < 0.00001 && Math.abs(curr.lon - prev.lon) < 0.00001) {
      if (curr.groundspeed > 10) {
        issues.push(`Snapshot ${i}: Position unchanged but GS=${curr.groundspeed.toFixed(0)}kts`);
      }
    }

    // Check for large position jumps
    const latDelta = curr.lat - prev.lat;
    const lonDelta = curr.lon - prev.lon;
    const distMeters = Math.sqrt(
      Math.pow(latDelta * 111320, 2) +
      Math.pow(lonDelta * 111320 * Math.cos(curr.lat * Math.PI / 180), 2)
    );
    const timeDelta = (curr.localTimestamp - prev.localTimestamp) / 1000;
    const avgGS = (curr.groundspeed + prev.groundspeed) / 2;
    const expectedDist = avgGS * 0.514444 * timeDelta;

    if (distMeters > expectedDist * 2 && distMeters > 50) {
      issues.push(`Snapshot ${i}: Position jump ${distMeters.toFixed(0)}m vs expected ${expectedDist.toFixed(0)}m`);
    }

    // Check for high position age
    if (curr.positionAge !== null && curr.positionAge > 5) {
      issues.push(`Snapshot ${i}: High position age ${curr.positionAge.toFixed(1)}s`);
    }

    // Check for backwards API timestamp
    if (curr.apiTimestamp < prev.apiTimestamp) {
      issues.push(`Snapshot ${i}: API timestamp went backwards! ${curr.apiTimestamp} < ${prev.apiTimestamp}`);
    }

    // Check for same API timestamp
    if (curr.apiTimestamp === prev.apiTimestamp && curr.groundspeed > 10) {
      issues.push(`Snapshot ${i}: Same API timestamp (${curr.apiTimestamp}) - stale data`);
    }
  }

  if (issues.length > 0) {
    console.log(`  ⚠️ Issues detected:`);
    for (const issue of issues) {
      console.log(`    - ${issue}`);
    }
  }
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Deauthenticate from RealTraffic API
 * Releases the session on the server to allow immediate reconnection
 */
async function deauthenticate() {
  if (!sessionGuid) {
    return;
  }

  console.log('Deauthenticating from RealTraffic...');

  try {
    const response = await postForm(`${API_BASE}/deauth`, {
      GUID: sessionGuid
    });

    if (response.status === 200) {
      console.log('Deauth successful');
    } else {
      console.log(`Deauth returned status ${response.status}: ${response.message || ''}`);
    }
  } catch (error) {
    console.error('Deauth failed:', error.message);
  }

  sessionGuid = null;
}

/**
 * Main entry point
 */
async function main() {
  console.log('RealTraffic Interpolation Debug Script');
  console.log('======================================');
  console.log(`Center: ${CENTER_LAT.toFixed(4)}, ${CENTER_LON.toFixed(4)} (KSFO)`);
  console.log(`Radius: ${RADIUS_NM} NM`);
  console.log(`BBox: ${BBOX.latMin.toFixed(4)} to ${BBOX.latMax.toFixed(4)}, ${BBOX.lonMin.toFixed(4)} to ${BBOX.lonMax.toFixed(4)}`);
  console.log('');

  try {
    await authenticate();
    console.log(`\nWaiting ${trafficRateLimit}ms before first poll...\n`);
    await sleep(trafficRateLimit);
    console.log('Starting poll loop...\n');
    await pollLoop();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
  console.log('\n\nInterrupted. Final analysis:');
  printAnalysis();

  // Deauthenticate to release the session
  await deauthenticate();

  process.exit(0);
});

main();
