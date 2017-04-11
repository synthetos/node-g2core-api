#!/usr/bin/env node

/* eslint camelcase: "off" */

// let util = require('util');
let fs = require('fs');
let readline = require('readline');
let sprintf = require('sprintf-js').sprintf;

let args = require('yargs')
  .option('log', {
    alias: 'g',
    desc: 'Name of file to log to. Piping STDERR to a file will do the same ' +
          'thing (and trump this option).',
  })
  .help('help')
  .alias('help', 'h')
  .argv;

const rl = readline.createInterface({
  input: fs.createReadStream(args.log),
});

const line_match = /\[\[\<[0-9]+\]\]({"sr".*)$/;
status = {posx: 0, posy: 0, posz: 0, he1st: 0, he1t: 0, he1op: 0};

rl.on('line', (line) => {
  let my_results;
  if (my_results = line_match.exec(line)) {
    try {
      sr = JSON.parse(my_results[1]).sr;
    } catch (e) {
      return;
    };

    for (key in sr) {
      if ({}.hasOwnProperty.call(sr, key)) {
        status[key] = sr[key];
      }
    }

    if ('posx' in sr || 'posy' in sr || 'posz' in sr) {
      // let red = Math.min(Math.max(0, status.he1t - status.he1st), 10.0)/10.0;
      // let green = Math.min(Math.max(0, status.he1st - status.he1t), 10.0)/10.0;
      // let blue = 0;

      let red = status.he1op * 255;
      let green = status.he1op * 255;
      let blue = status.he1op * 255;

      process.stdout.write(
        `${status.posx} ${status.posy} ${status.posz} ${red} ${green} ${blue}\n`
      );
    }
  }
});
