#!/usr/bin/env node

/* eslint camelcase: "off" */

// let util = require('util');
let fs = require('fs');
let readline = require('readline');
// let sprintf = require('sprintf-js').sprintf;

let args = require('yargs')
  .option('log', {
    alias: 'g',
    desc: 'Name of file to log to. Piping STDERR to a file will do the same ' +
          'thing (and trump this option).',
  })
  .option('power_cloud', {
    alias: 'p',
    boolean: true,
    desc: 'Output a point cloud, with x, y, z, r, g, b as the columns, ' +
          'color is power usage',
  })
  .option('heat_cloud', {
    alias: 'H',
    boolean: true,
    desc: 'Output a point cloud, with x, y, z, r, g, b as the columns, ' +
          'color is distance from set temperature',
  })
  .option('heat_scale', {
    desc: 'Scale value for heat_cloud. Red = temp + heat_scale,' +
          'Blue = temp - heat_scale ',
    default: 5,
    type: 'number',
  })
  .option('temp_graph', {
    alias: 't',
    boolean: true,
    desc: 'Output a temperature graph, with time, set temp, actual temp, ' +
          'power level as the outputs',
  })
  .option('velocity', {
    boolean: true,
    desc: 'Output a point cloud, with x, y, z, r, g, b as the columns, ' +
          'color is velocity, from black = 0 to white = 255',
  })
  .option('motors', {
    boolean: true,
    desc: 'Output a point cloud, with x, y, z, r, g, b as the columns, ' +
          'color is motor stall-guard-value, from black = 0 to white = 255',
  })
  .option('log_default', {
    alias: 'L',
    boolean: true,
    desc: 'Name of file to log to. Piping STDERR to a file will do the same ' +
          'thing (and trump this option).',
  })
  .help('help')
  .alias('help', 'h')
  .argv;

const rl = readline.createInterface({
  input: fs.createReadStream(args.log),
});

const line_match = /\[\[\<([0-9]+)\]\]({"sr".*)$/;
const r_match = /\[\[\<([0-9]+)\]\]({"r".*)$/;
status = {
  'posx': 0, 'posy': 0, 'posz': 0,
  'he1st': 0, 'he1st': 0, 'he1t': 0, 'he1op': 0, 'he1p': 0, 'he1i': 0,
  'he1d': 0, 'he1f': 0, 'pid1p': 0, 'pid1i': 0, 'pid1d': 0, 'pid1f': 0,
  '1sgr': 0, '2sgr': 0, '3sgr': 0, '4sgr': 0, '5sgr': 0,
};

first_tc = -1;

if (args.temp_graph) {
  process.stdout.write(
    `time,he1st,he1t,he1op,he1op-s,he1p,he1i,he1d,he1f,` +
    `pid1p,pid1p-s,pid1i,pid1i-s,pid1d,pid1d-s,pid1f\n`
  );
}

rl.on('line', (line) => {
  let my_results;
  if (my_results = r_match.exec(line)) {
    // try {
      r = JSON.parse(my_results[2]).r;
    // } catch (e) {
      // return;
    // };

    for (key in r) {
      if ({}.hasOwnProperty.call(r, key)) {
        if (key == 'he1') {
          for (key in r.he1) {
            if ({}.hasOwnProperty.call(r.he1, key)) {
              status[`he1${key}`] = r.he1[key];
            }
          }
        } else {
          status[key] = r[key];
        }
      }
    }
  } else
  if (my_results = line_match.exec(line)) {
    tc = (my_results[1]) / 1000;
    if (first_tc == -1) {
      first_tc = tc;
      tc = 0;
    } else {
      tc -= first_tc;
    }

    try {
      sr = JSON.parse(my_results[2]).sr;
    } catch (e) {
      return;
    };

    for (key in sr) {
      if ({}.hasOwnProperty.call(sr, key)) {
        status[key] = sr[key];
      }
    }

    if (args.temp_graph) {
      if ('he1t' in sr || 'he1st' in sr || 'he1t' in sr || 'he1op' in sr ||
          'he1p' in sr || 'he1i' in sr || 'he1d' in sr || 'he1f' in sr ||
          'pid1p' in sr || 'pid1i' in sr || 'pid1d' in sr || 'pid1f' in sr) {
        process.stdout.write(
          `${tc},${status.he1st},${status.he1t},${status.he1op},` +
          `${status.he1op*300},` +
          `${status.he1p},${status.he1i},${status.he1d},${status.he1f},` +
          `${status.pid1p},${status.pid1p/10000},${status.pid1i},` +
          `${status.pid1i/1000},${status.pid1d},${status.pid1d/10000},` +
          `${status.pid1f}\n`
        );
      }
    } else
    if (args.power_cloud || args.heat_cloud || args.velocity || args.motors) {
      if ('posx' in sr || 'posy' in sr || 'posz' in sr) {
        let red = 0;
        let green = 0;
        let blue = 0;

        if (args.power_cloud) {
          // red = status.he1op;
          // green = status.he3op;
          red = (status.he1op + status.he3op)/2;
          green = red;
          blue = red;
        } else if (args.heat_cloud) {
          red = Math.min(
            Math.max(0, status.he1t - status.he1st),
            args.heat_scale)/args.heat_scale;
          blue = Math.min(
            Math.max(0, status.he1st - status.he1t),
            args.heat_scale)/args.heat_scale;
        } else if (args.velocity) {
          red = Math.max(status.vel / 255, 1);
          green = red;
          blue = red;
        } else if (args.motors) {
          red = 1.0-Math.min(1.0, status['1sgr']/100);
          green = 1.0-Math.min(1.0, status['2sgr']/100);
          blue = 1.0-Math.min(1.0, status['4sgr']/100);
        }

        process.stdout.write(
          `${status.posx};${status.posy};${status.posz};` +
          `${red * 255};${green * 255};${blue * 255}\n`
        );
      }
    }
  }
});
