var fs = require('fs');
var http = require('http');
var https = require('https');
var url = require("url");
var zlib = require('zlib');
var os = require('os');

var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);
var charts = require('./charts.js');
var utils = require('./utils.js');
var authSid = Math.round(Math.random() * 10000000000) + '' + Math.round(Math.random() * 10000000000);

var logSystem = 'api';
require('./exceptionWriter.js')(logSystem);

var redisCommands = [
    ['zremrangebyscore', config.coin + ':hashrate', '-inf', ''],
    ['zrange', config.coin + ':hashrate', 0, -1],
    ['hgetall', config.coin + ':stats'],
    ['zrange', config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES'],
    ['zrevrange', config.coin + ':blocks:matured', 0, config.api.blocks - 1, 'WITHSCORES'],
    ['hgetall', config.coin + ':shares:roundCurrent'],
    ['hgetall', config.coin + ':stats'],
    ['zcard', config.coin + ':blocks:matured'],
    ['zrevrange', config.coin + ':payments:all', 0, config.api.payments - 1, 'WITHSCORES'],
    ['zcard', config.coin + ':payments:all'],
    ['keys', config.coin + ':payments:*']
];

var currentStats = "";
var currentStatsCompressed = "";

var minerStats = {};
var minersHashrate = {};

var liveConnections = {};
var addressConnections = {};

function handleServerRequest(request, response) {
    var urlParts = url.parse(request.url, true);

    switch(urlParts.pathname){
        case '/stats':
            var deflate = request.headers['accept-encoding'] && request.headers['accept-encoding'].indexOf('deflate') != -1;
            var reply = deflate ? currentStatsCompressed : currentStats;
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': deflate ? 'deflate' : '',
                'Content-Length': reply.length
            });
            response.end(reply);
            break;
        case '/live_stats':
            response.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Encoding': 'deflate',
                'Connection': 'keep-alive'
            });
            var uid = Math.random().toString();
            liveConnections[uid] = response;
            response.on("finish", function() {
                delete liveConnections[uid];
            });
            response.on("error", function() {
                delete liveConnections[uid];
            });
            break;
        case '/stats_address':
            handleMinerStats(urlParts, response);
            break;
        case '/get_payments':
            handleGetPayments(urlParts, response);
            break;
        case '/get_blocks':
            handleGetBlocks(urlParts, response);
            break;
        case '/get_top10miners':
            handleTopMiners(response);
            break;
        case '/get_top100workers':
            handleTopWorkers(response);
            break;
        case '/get_top100solvers':
            handleTopSolvers(response);
            break;
        case '/get_miner_payout_level':
            handleGetMinerPayoutLevel(urlParts, response);
            break;
        case '/set_miner_payout_level':
            handleSetMinerPayoutLevel(urlParts, response);
            break;
        case '/admin_stats':
            if (!authorize(request, response))
                return;
            handleAdminStats(response);
            break;
        case '/admin_monitoring':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminMonitoring(response);
            break;
        case '/admin_log':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminLog(urlParts, response);
            break;
        case '/admin_users':
            if(!authorize(request, response)) {
                return;
            }
            handleAdminUsers(response);
            break;
        case '/admin_ports':
            if (!authorize(request, response)) {
                return;
            }
            handleAdminPorts(response);
            break;

        case '/miners_hashrate':
            if (!authorize(request, response))
                return;
            handleGetMinersHashrate(response);
            break;
        case '/stats_worker':
            handleWorkerStats(urlParts, response);
            break;

        default:
            response.writeHead(404, {
                'Access-Control-Allow-Origin': '*'
            });
            response.end('Invalid API call');
            break;
    }
}

function collectStats(){

    var startTime = Date.now();
    var redisFinished;
    var daemonFinished;

    var windowTime = (((Date.now() / 1000) - config.api.hashrateWindow) | 0).toString();
    redisCommands[0][3] = '(' + windowTime;

    async.parallel({
        pool: function(callback){
            redisClient.multi(redisCommands).exec(function(error, replies){

                redisFinished = Date.now();
                var dateNowSeconds = Date.now() / 1000 | 0;

                if (error){
                    log('error', logSystem, 'Error getting redis data %j', [error]);
                    callback(true);
                    return;
                }

                var data = {
                    stats: replies[2],
                    blocks: replies[3].concat(replies[4]),
                    totalBlocks: parseInt(replies[7]) + (replies[3].length / 2),
                    payments: replies[8],
                    totalPayments: parseInt(replies[9]),
                    totalMinersPaid: replies[10].length - 1
                };

                var hashrates = replies[1];

                minerStats = {};
                minersHashrate = {};

                for (var i = 0; i < hashrates.length; i++){
                    var hashParts = hashrates[i].split(':');
                    minersHashrate[hashParts[1]] = (minersHashrate[hashParts[1]] || 0) + parseInt(hashParts[0]);
                }

                var totalShares = 0;
                var totalWorkers = 0;

                for (var miner in minersHashrate){
                    var shares = minersHashrate[miner];
                    if (miner.indexOf('+') != -1) {
                        totalShares += shares;
                        if (shares > 0) {
                            totalWorkers++;
                        }
                    }
                    minersHashrate[miner] = Math.round(shares / config.api.hashrateWindow);
                    var minerParts = miner.split('+');
                    minerStats[minerParts[0]] = (minersHashrate[miner] || 0) + (parseInt(minerStats[minerParts[0]]) || 0);
                }
                data.miners = Object.keys(minerStats).length;
                data.workers = totalWorkers;

                data.hashrate = Math.round(totalShares / config.api.hashrateWindow);

                data.roundHashes = 0;

                if (replies[5]){
                    for (var miner in replies[5]){
                        if (config.poolServer.slushMining.enabled) {
                            data.roundHashes +=  parseInt(replies[5][miner]) / Math.pow(Math.E, ((data.lastBlockFound - dateNowSeconds) / config.poolServer.slushMining.weight)); //TODO: Abstract: If something different than lastBlockfound is used for scoreTime, this needs change. 
                        }
                        else {
                            data.roundHashes +=  parseInt(replies[5][miner]);
                        }
                    }
                }

                if (replies[6]) {
                    data.lastBlockFound = replies[6].lastBlockFound;
                }

                callback(null, data);
            });
        },
        network: function(callback){
            apiInterfaces.rpcDaemon('getlastblockheader', {}, function(error, reply){
                daemonFinished = Date.now();
                if (error){
                    log('error', logSystem, 'Error getting daemon data %j', [error]);
                    callback(true);
                    return;
                }
                var blockHeader = reply.block_header;
                callback(null, {
                    difficulty: blockHeader.difficulty,
                    height: blockHeader.height + 1,
                    timestamp: blockHeader.timestamp,
                    reward: blockHeader.reward,
                    hash:  blockHeader.hash
                });
            });
        },
        config: function(callback){
            callback(null, {
                ports: getPublicPorts(config.poolServer.ports),
                hashrateWindow: config.api.hashrateWindow,
                fee: config.blockUnlocker.poolFee,
                coin: config.coin,
                coinUnits: config.coinUnits,
                coinDifficultyTarget: config.coinDifficultyTarget,
                symbol: config.symbol,
                depth: config.blockUnlocker.depth,
                solverReward: config.blockUnlocker.solverReward,
                donation: donations,
                version: version,
                paymentsInterval: config.payments.interval,
                minPaymentThreshold: config.payments.minPayment,
                maxPaymentThreshold: config.payments.maxPayment || -1,
                denominationUnit: config.payments.denomination,
                blockTime: config.coinDifficultyTarget,
                slushMiningEnabled: config.poolServer.slushMining.enabled,
                weight: config.poolServer.slushMining.weight,
                blocksChartEnabled: (config.charts.blocks && config.charts.blocks.enabled),
                blocksChartDays: config.charts.blocks && config.charts.blocks.days ? config.charts.blocks.days : null
            });
        },
        charts: function (callback) {
            // Get enabled charts data
            charts.getPoolChartsData(function(error, data) {
                if (error) {
                    callback(error, data);
                    return;
                }

                // Blocks chart
                if (!config.charts.blocks || !config.charts.blocks.enabled || !config.charts.blocks.days) {
                    callback(error, data);
                    return;
                }

                var chartDays = config.charts.blocks.days;

                var beginAtTimestamp = (Date.now() / 1000) - (chartDays * 86400);
                var beginAtDate = new Date(beginAtTimestamp * 1000);
                if (chartDays > 1) {
                    beginAtDate = new Date(beginAtDate.getFullYear(), beginAtDate.getMonth(), beginAtDate.getDate(), 0, 0, 0, 0);
                    beginAtTimestamp = beginAtDate / 1000 | 0;
                }

                var blocksCount = {};
                if (chartDays === 1) {
                    for (var h = 0; h <= 24; h++) {
                        var date = utils.dateFormat(new Date((beginAtTimestamp + (h * 60 * 60)) * 1000), 'yyyy-mm-dd HH:00');
                        blocksCount[date] = 0;
                    }
                } else {
                    for (var d = 0; d <= chartDays; d++) {
                        var date = utils.dateFormat(new Date((beginAtTimestamp + (d * 86400)) * 1000), 'yyyy-mm-dd');
                        blocksCount[date] = 0;
                    }
                }

                redisClient.zrevrange(config.coin + ':blocks:matured', 0, -1, 'WITHSCORES', function(err, result) {
                    for (var i = 0; i < result.length; i++){
                        var block = result[i].split(':');
                        if (block[5]) {
                            var blockTimestamp = block[1];
                            if (blockTimestamp < beginAtTimestamp) {
                                continue;
                            }
                            var date = utils.dateFormat(new Date(blockTimestamp * 1000), 'yyyy-mm-dd');
                            if (chartDays === 1) date = utils.dateFormat(new Date(blockTimestamp * 1000), 'yyyy-mm-dd HH:00');
                            if (!blocksCount[date]) blocksCount[date] = 0;
                            blocksCount[date] ++;
                        }
                    }
                    data.blocks = blocksCount;
                    callback(error, data);
                });
            });
        },
        system: function(callback){
          var os_load = os.loadavg();
          var num_cores = os.cpus().length;
          callback(null, {
            load: os_load,
            number_cores: num_cores
          });
        }
    }, function(error, results){

        log('info', logSystem, 'Stat collection finished: %d ms redis, %d ms daemon', [redisFinished - startTime, daemonFinished - startTime]);

        if (error){
            log('error', logSystem, 'Error collecting all stats');
        }
        else{
            currentStats = JSON.stringify(results);
            zlib.deflateRaw(currentStats, function(error, result){
                currentStatsCompressed = result;
                broadcastLiveStats();
            });

        }

        setTimeout(collectStats, config.api.updateInterval * 1000);
    });

}

function getPublicPorts(ports){
    return ports.filter(function(port) {
        return !port.hidden;
    });
}

function getReadableHashRateString(hashrate){
    var i = 0;
    var byteUnits = [' H', ' KH', ' MH', ' GH', ' TH', ' PH' ];
    while (hashrate > 1000){
        hashrate = hashrate / 1000;
        i++;
    }
    return hashrate.toFixed(2) + byteUnits[i];
}

function broadcastLiveStats(){

    log('info', logSystem, 'Broadcasting to %d visitors and %d address lookups', [Object.keys(liveConnections).length, Object.keys(addressConnections).length]);

    for (var uid in liveConnections){
        var res = liveConnections[uid];
        res.end(currentStatsCompressed);
    }

    var redisCommands = [];
    for (var address in addressConnections){
        redisCommands.push(['hgetall', config.coin + ':workers:' + address]);
        redisCommands.push(['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES']);
    }
    redisClient.multi(redisCommands).exec(function(error, replies){

        var addresses = Object.keys(addressConnections);

        for (var i = 0; i < addresses.length; i++){
            var offset = i * 2;
            var address = addresses[i];
            var stats = replies[offset];
            var res = addressConnections[address];
            if (!stats){
                res.end(JSON.stringify({error: "not found"}));
                return;
            }
            stats.hashrate = minerStats[address];
            res.end(JSON.stringify({stats: stats, payments: replies[offset + 1]}));
        }
    });
}

function handleMinerStats(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=3',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');
    var address = urlParts.query.address;

    redisClient.multi([
        ['hgetall', config.coin + ':workers:' + address],
        ['zrevrange', config.coin + ':payments:' + address, 0, config.api.payments - 1, 'WITHSCORES'],
        ['keys', config.coin + ':charts:hashrate:' + address + '*']
    ]).exec(function(error, replies){
        if (error || !replies[0]){
            response.end(JSON.stringify({error: 'not found'}));
            return;
        }
        var stats = replies[0];
        //console.log(replies);
        stats.hashrate = minerStats[address];

        // Grab the worker names.
        var workers = [];
        for (var i=0; i<replies[2].length; i++) {
            var key = replies[2][i];
            var nameOffset = key.indexOf('+');
            if (nameOffset != -1) {
                workers.push(key.substr(nameOffset + 1));
            }
        }

        charts.getUserChartsData(address, replies[1], function(error, chartsData) {
            response.end(JSON.stringify({
                stats: stats,
                payments: replies[1],
                charts: chartsData,
                workers: workers
            }));
        });
    });
}

function handleWorkerStats(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');
    var address = urlParts.query.address;

    charts.getUserChartsData(address, [], function(error, chartsData) {
      response.end(JSON.stringify({ charts: chartsData }));
    });
}

function handleGetPayments(urlParts, response){
    var paymentKey = ':payments:all';

    if (urlParts.query.address)
        paymentKey = ':payments:' + urlParts.query.address;

    redisClient.zrevrangebyscore(
            config.coin + paymentKey,
            '(' + urlParts.query.time,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.payments,
        function(err, result){

            var reply;

            if (err)
                reply = JSON.stringify({error: 'query failed'});
            else
                reply = JSON.stringify(result);

            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': reply.length
            });
            response.end(reply);

        }
    )
}

function handleGetBlocks(urlParts, response){
    redisClient.zrevrangebyscore(
            config.coin + ':blocks:matured',
            '(' + urlParts.query.height,
            '-inf',
            'WITHSCORES',
            'LIMIT',
            0,
            config.api.blocks,
        function(err, result){

        var reply;

        if (err)
            reply = JSON.stringify({error: 'query failed'});
        else
            reply = JSON.stringify(result);

        response.writeHead("200", {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'Content-Length': reply.length
        });
        response.end(reply);

    });
}

function handleGetMinersHashrate(response) {
    var reply = JSON.stringify({
        minersHashrate: minersHashrate
    });
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': reply.length
    });
    response.end(reply);
}

/**
 * Check if a miner has been seen with specified IP address
 **/
function minerSeenWithIPForAddress(address, ip, callback) {
    redisClient.sismember([config.coin + ':workers_ip:' + address, ip], function(error, result) {
        var found = result > 0 ? true : false;
        if (found === false) {
            /* Re-check if the IPv4 address was mapped as IPv6 address */
            var ipv4_regex = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
            if (ipv4_regex.test(ip)) {
                /* Is valid IPv4 address */
                ip = '::ffff:' + ip;
                redisClient.sismember([config.coin + ':workers_ip:' + address, ip], function(error, result) {
                    var found = result > 0 ? true : false;
                    callback(error, found);
                });
            }
            else {
                /* Is not valid IPv4 address */
                callback(error, false);
            }
        }
        else {
            callback(error, true);
        }
    });
}

function parseCookies(request) {
    var list = {},
        rc = request.headers.cookie;
    rc && rc.split(';').forEach(function(cookie) {
        var parts = cookie.split('=');
        list[parts.shift().trim()] = unescape(parts.join('='));
    });
    return list;
}

function authorize(request, response){
    if(request.connection.remoteAddress == '127.0.0.1') {
        return true;
    }

    response.setHeader('Access-Control-Allow-Origin', '*');

    var cookies = parseCookies(request);
    if(cookies.sid && cookies.sid == authSid) {
        return true;
    }

    var sentPass = url.parse(request.url, true).query.password;


    if (sentPass !== config.api.password){
        response.statusCode = 401;
        response.end('invalid password');
        return;
    }

    log('warn', logSystem, 'Admin authorized');
    response.statusCode = 200;

    var cookieExpire = new Date( new Date().getTime() + 60*60*24*1000);
    response.setHeader('Set-Cookie', 'sid=' + authSid + '; path=/; expires=' + cookieExpire.toUTCString());
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Content-Type', 'application/json');


    return true;
}

function handleAdminStats(response){

    async.waterfall([

        //Get worker keys & unlocked blocks
        function(callback){
            redisClient.multi([
                ['keys', config.coin + ':workers:*'],
                ['zrange', config.coin + ':blocks:matured', 0, -1]
            ]).exec(function(error, replies) {
                if (error) {
                    log('error', logSystem, 'Error trying to get admin data from redis %j', [error]);
                    callback(true);
                    return;
                }
                callback(null, replies[0], replies[1]);
            });
        },

        //Get worker balances
        function(workerKeys, blocks, callback){
            var redisCommands = workerKeys.map(function(k){
                return ['hmget', k, 'balance', 'paid'];
            });
            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                    callback(true);
                    return;
                }

                callback(null, replies, blocks);
            });
        },
        function(workerData, blocks, callback){
            var stats = {
                totalOwed: 0,
                totalPaid: 0,
                totalRevenue: 0,
                totalDiff: 0,
                totalShares: 0,
                blocksOrphaned: 0,
                blocksUnlocked: 0,
                totalWorkers: 0
            };

            for (var i = 0; i < workerData.length; i++){
                stats.totalOwed += parseInt(workerData[i][0]) || 0;
                stats.totalPaid += parseInt(workerData[i][1]) || 0;
                stats.totalWorkers++;
            }

            for (var i = 0; i < blocks.length; i++){
                var block = blocks[i].split(':');
                if (block[5]) {
                    stats.blocksUnlocked++;
                    stats.totalDiff += parseInt(block[2]);
                    stats.totalShares += parseInt(block[3]);
                    stats.totalRevenue += parseInt(block[5]);
                }
                else{
                    stats.blocksOrphaned++;
                }
            }
            callback(null, stats);
        }
    ], function(error, stats){
            if (error){
                response.end(JSON.stringify({error: 'error collecting stats'}));
                return;
            }
            response.end(JSON.stringify(stats));
        }
    );

}


function handleAdminUsers(response){
    async.waterfall([
        // get workers Redis keys
        function(callback) {
            redisClient.keys(config.coin + ':workers:*', callback);
        },
        // get workers data
        function(workerKeys, callback) {
            var redisCommands = workerKeys.map(function(k) {
                return ['hmget', k, 'balance', 'paid', 'lastShare', 'hashes', 'minPayoutLevel'];
            });
            redisClient.multi(redisCommands).exec(function(error, redisData) {
                var workersData = {};
                var addressLength = config.poolServer.poolAddress.length;
                for(var i in redisData) {
                    var address = workerKeys[i].substr(-addressLength);
                    var data = redisData[i];
                    var hashrate = 0;
                    for (var miner in minersHashrate) {
                        if (miner.indexOf(address) == 0) {
                            hashrate += minersHashrate[miner];
                        }
                    }
                    workersData[address] = {
                        pending: data[0],
                        paid: data[1],
                        lastShare: data[2],
                        hashes: data[3],
                        minimumPayout: data[4],
                        hashrate: hashrate
                    };
                }
                callback(null, workersData);
            });
        }
    ], function(error, workersData) {
            if(error) {
                response.end(JSON.stringify({error: 'error collecting users stats'}));
                return;
            }
            response.end(JSON.stringify(workersData));
        }
    );
}

/**
 * Administration: pool ports usage
 **/
function handleAdminPorts(response){
    async.waterfall([
        function(callback) {
            redisClient.keys(config.coin + ':ports:*', callback);
        },
        function(portsKeys, callback) {
            var redisCommands = portsKeys.map(function(k) {
                return ['hmget', k, 'port', 'users'];
            });
            redisClient.multi(redisCommands).exec(function(error, redisData) {
                var portsData = {};
                for (var i in redisData) {
                    var port = portsKeys[i];
                    var data = redisData[i];
                    portsData[port] = {
                        port: data[0],
                        users: data[1]
                    };
                }
                callback(null, portsData);
            });
        }
    ], function(error, portsData) {
        if(error) {
            response.end(JSON.stringify({error: 'Error collecting Ports stats'}));
            return;
        }
        response.end(JSON.stringify(portsData));
    });
}

function compare(a,b){
    if (a.hashrate > b.hashrate)
        return -1;
    if (a.hashrate < b.hashrate)
        return 1;
    return 0;
}

function handleTopMiners(response){
    async.waterfall([
        // get workers Redis keys
        function(callback) {
            redisClient.keys(config.coin + ':workers:*', callback);
        },
        // get workers data
        function(workerKeys, callback) {
            var redisCommands = workerKeys.map(function(k) {
                return ['hmget', k, 'hashes'];
            });
            redisClient.multi(redisCommands).exec(function(error, redisData) {
                var data = [];
                var addressLength = config.poolServer.poolAddress.length;
                for(var i in redisData) {
                    var address = workerKeys[i].substr(-addressLength);
                    var hashrate = 0;
                    for (var worker in minersHashrate) {
                        if (worker == address || worker.substring(0, addressLength + 1) == (address + "+")) {
                            hashrate += minersHashrate[worker];
                        }
                    }
                    data.push({ miner:'**'+address.substring(89), hashrate: hashrate });
                }
                callback(null, data);
            });
        }
    ], function(error, data) {
            if(error) {
                response.end(JSON.stringify({error: 'error collecting users stats'}));
                return;
            }
            data.sort(compare);
            data = data.slice(0,10);
            var reply = JSON.stringify(data);
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': reply.length
            });
            response.end(reply);
        }
    );
}

function handleTopWorkers(response){
    var data = [];
    for (var worker in minersHashrate) {
         data.push({ worker: worker, hashrate: minersHashrate[worker] });
    }
    data.sort(compare);
    data = data.slice(0,100);
    var reply = JSON.stringify(data);
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': reply.length
    });
    response.end(reply);
}

function compareblocks(a,b){
    if (a.blocks > b.blocks)
        return -1;
    if (a.blocks < b.blocks)
        return 1;
    if (a.hashes > b.hashes)
        return 1;
    if (a.hashes < b.hashes)
        return -1;
    return 0;
}

function handleTopSolvers(response){
    async.waterfall([
        // get workers Redis keys
        function(callback) {
            redisClient.keys(config.coin + ':workers:*', callback);
        },
        // get workers data
        function(workerKeys, callback) {
            var redisCommands = workerKeys.map(function(k) {
                return ['hmget', k, 'blocks', 'hashes'];
            });
            redisClient.multi(redisCommands).exec(function(error, redisData) {
                var data = [];
                var addressLength = config.poolServer.poolAddress.length;
                for(var i in redisData) {
                    var address = workerKeys[i].substr(-addressLength);
                    var hashrate = 0;
                    for (var worker in minersHashrate) {
                        if (worker == address || worker.substring(0, addressLength + 1) == (address + "+")) {
                            hashrate += minersHashrate[worker];
                        }
                    }
                    data.push({ miner:'**'+address.substring(89), hashrate: hashrate, blocks: parseInt(redisData[i][0] || 0), hashes: parseInt(redisData[i][1] || 0) });
                }
                callback(null, data);
            });
        }
    ], function(error, data) {
            if(error) {
                response.end(JSON.stringify({error: 'error collecting users stats'}));
                return;
            }
            data.sort(compareblocks);
            data = data.slice(0,100);
            var reply = JSON.stringify(data);
            response.writeHead("200", {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
                'Content-Type': 'application/json',
                'Content-Length': reply.length
            });
            response.end(reply);
        }
    );
}

/**
 * Miner settings: minimum payout level
 **/

// Get current minimum payout level
function handleGetMinerPayoutLevel(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var address = urlParts.query.address;

    // Check the minimal required parameters for this handle.
    if (address === undefined) {
        response.end(JSON.stringify({'status': 'Parameters are incomplete'}));
        return;
    }

    // Return current miner payout level
    redisClient.hget(config.coin + ':workers:' + address, 'minPayoutLevel', function(error, value){
        if (error){
            response.end(JSON.stringify({'status': 'Unable to get the current minimum payout level from database'}));
            return;
        }

        var minLevel = config.payments.minPayment / config.coinUnits;
        if (minLevel < 0) minLevel = 0;

        var currentLevel = value / config.coinUnits;
        if (currentLevel < minLevel) currentLevel = minLevel;

        response.end(JSON.stringify({'status': 'done', 'level': currentLevel}));
    });
}

// Set minimum payout level
function handleSetMinerPayoutLevel(urlParts, response){
    response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
    });
    response.write('\n');

    var address = urlParts.query.address;
    var ip = urlParts.query.ip;
    var level = urlParts.query.level;

    // Check the minimal required parameters for this handle.
    if (ip === undefined || address === undefined || level === undefined) {
        response.end(JSON.stringify({'status': 'Parameters are incomplete'}));
        return;
    }

    // Do not allow wildcards in the queries.
    if (ip.indexOf('*') !== -1 || address.indexOf('*') !== -1) {
        response.end(JSON.stringify({'status': 'Remove the wildcard from your miner address'}));
        return;
    }

    level = parseFloat(level);
    if (isNaN(level)) {
        response.end(JSON.stringify({'status': 'Your minimum payout level doesn\'t look like a number'}));
        return;
    }

    var minLevel = config.payments.minPayment / config.coinUnits;
    var maxLevel = config.payments.maxPayment / config.coinUnits;
    if (minLevel < 0) minLevel = 0;
    if (maxLevel < 0) maxLevel = config.payments.maxTransactionAmount / config.coinUnits;

    if (level != 0 && level < minLevel) {
        response.end(JSON.stringify({'status': 'The minimum payout level is ' + minLevel}));
        return;
    }

    if (level > maxLevel) {
        response.end(JSON.stringify({'status': 'The maximum payout level is ' + maxLevel}));
        return;
    }

    // Only do a modification if we have seen the IP address in combination with the wallet address.
    minerSeenWithIPForAddress(address, ip, function (error, found) {
        if (!found || error) {
          response.end(JSON.stringify({'status': 'We haven\'t seen that IP for your address'}));
          return;
        }

        var payoutLevel = level * config.coinUnits;
        if (payoutLevel == 0) {
            redisClient.hdel(config.coin + ':workers:' + address, 'minPayoutLevel', function(error, value){
                if (error){
                    response.end(JSON.stringify({'status': 'An error occurred when removing the value from our database'}));
                    return;
                }

                log('info', logSystem, 'Removed minimum payout level for ' + address);
                response.end(JSON.stringify({'status': 'done'}));
            });
        } else {
            redisClient.hset(config.coin + ':workers:' + address, 'minPayoutLevel', payoutLevel, function(error, value){
                if (error){
                    response.end(JSON.stringify({'status': 'An error occurred when updating the value in our database'}));
                    return;
                }

                log('info', logSystem, 'Updated minimum payout level for ' + address + ' to: ' + payoutLevel);
                response.end(JSON.stringify({'status': 'done'}));
            });
        }
    });
}

function handleAdminMonitoring(response) {
    response.writeHead("200", {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json'
    });
    async.parallel({
        monitoring: getMonitoringData,
        logs: getLogFiles
    }, function(error, result) {
        response.end(JSON.stringify(result));
    });
}

function handleAdminLog(urlParts, response){
    var file = urlParts.query.file;
    var filePath = config.logging.files.directory + '/' + file;
    if(!file.match(/^\w+\.log$/)) {
        response.end('wrong log file');
    }
    response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache',
        'Content-Length': fs.statSync(filePath).size
    });
    fs.createReadStream(filePath).pipe(response)
}


function startRpcMonitoring(rpc, module, method, interval) {
    setInterval(function() {
        rpc(method, {}, function(error, response) {
            var stat = {
                lastCheck: new Date() / 1000 | 0,
                lastStatus: error ? 'fail' : 'ok',
                lastResponse: JSON.stringify(error ? error : response)
            };
            if(error) {
                stat.lastFail = stat.lastCheck;
                stat.lastFailResponse = stat.lastResponse;
            }
            var key = getMonitoringDataKey(module);
            var redisCommands = [];
            for(var property in stat) {
                redisCommands.push(['hset', key, property, stat[property]]);
            }
            redisClient.multi(redisCommands).exec();
        });
    }, interval * 1000);
}

function getMonitoringDataKey(module) {
    return config.coin + ':status:' + module;
}

function initMonitoring() {
    var modulesRpc = {
        daemon: apiInterfaces.rpcDaemon,
        wallet: apiInterfaces.rpcWallet
    };
    for(var module in config.monitoring) {
        var settings = config.monitoring[module];
        if(settings.checkInterval) {
            startRpcMonitoring(modulesRpc[module], module, settings.rpcMethod, settings.checkInterval);
        }
    }
}



function getMonitoringData(callback) {
    var modules = Object.keys(config.monitoring);
    var redisCommands = [];
    for(var i in modules) {
        redisCommands.push(['hgetall', getMonitoringDataKey(modules[i])])
    }
    redisClient.multi(redisCommands).exec(function(error, results) {
        var stats = {};
        for(var i in modules) {
            if(results[i]) {
                stats[modules[i]] = results[i];
            }
        }
        callback(error, stats);
    });
}

function getLogFiles(callback) {
    var dir = config.logging.files.directory;
    fs.readdir(dir, function(error, files) {
        var logs = {};
        for(var i in files) {
            var file = files[i];
            var stats = fs.statSync(dir + '/' + file);
            logs[file] = {
                size: stats.size,
                changed: Date.parse(stats.mtime) / 1000 | 0
            }
        }
        callback(error, logs);
    });
}

/**
 * Start pool API
 **/

// Collect statistics for the first time
collectStats();

// Initialize RPC monitoring
initMonitoring();

// Enable to be bind to a certain ip or all by default
var bindIp = config.api.bindIp ? config.api.bindIp : "0.0.0.0";

var server = http.createServer(function(request, response){
    if (request.method.toUpperCase() === "OPTIONS"){

        response.writeHead("204", "No Content", {
            "access-control-allow-origin": '*',
            "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
            "access-control-allow-headers": "content-type, accept",
            "access-control-max-age": 10, // Seconds.
            "content-length": 0
        });

        return(response.end());
    }

    handleServerRequest(request, response);
});

server.listen(config.api.port, bindIp, function(){
    log('info', logSystem, 'API started & listening on %s port %d', [bindIp, config.api.port]);
});

// Start API on SSL port
if (config.api.ssl){
    if (!config.api.sslCert) {
        log('error', logSystem, 'Could not start API listening on %s port %d (SSL): SSL certificate not configured', [bindIp, config.api.sslPort]);
    } else if (!config.api.sslKey) {
        log('error', logSystem, 'Could not start API listening on %s port %d (SSL): SSL key not configured', [bindIp, config.api.sslPort]);
    } else if (!config.api.sslCA) {
        log('error', logSystem, 'Could not start API listening on %s port %d (SSL): SSL certificate authority not configured', [bindIp, config.api.sslPort]);
    } else if (!fs.existsSync(config.api.sslCert)) {
        log('error', logSystem, 'Could not start API listening on %s port %d (SSL): SSL certificate file not found (configuration error)', [bindIp, config.api.sslPort]);
    } else if (!fs.existsSync(config.api.sslKey)) {
        log('error', logSystem, 'Could not start API listening on %s port %d (SSL): SSL key file not found (configuration error)', [bindIp, config.api.sslPort]);
    } else if (!fs.existsSync(config.api.sslCA)) {
        log('error', logSystem, 'Could not start API listening on %s port %d (SSL): SSL certificate authority file not found (configuration error)', [bindIp, config.api.sslPort]);
    } else {
        var options = {
            key: fs.readFileSync(config.api.sslKey),
            cert: fs.readFileSync(config.api.sslCert),
            ca: fs.readFileSync(config.api.sslCA),
            honorCipherOrder: true
        };

        var ssl_server = https.createServer(options, function(request, response){
            if (request.method.toUpperCase() === "OPTIONS"){
                response.writeHead("204", "No Content", {
                    "access-control-allow-origin": '*',
                    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "access-control-allow-headers": "content-type, accept",
                    "access-control-max-age": 10, // Seconds.
                    "content-length": 0,
                    "strict-transport-security": "max-age=604800"
                });
                return(response.end());
            }

            handleServerRequest(request, response);
        });

        ssl_server.listen(config.api.sslPort, bindIp, function(){
            log('info', logSystem, 'API started & listening on %s port %d (SSL)', [bindIp, config.api.sslPort]);
        });
    }
}
