function getReadableHashRateString(hashrate){
    hashrate = hashrate || 0;
    var i = 0;
    var byteUnits = [' H', ' kH', ' MH', ' GH', ' TH', ' PH'];
    while (hashrate > 1000){
        hashrate = hashrate / 1000;
        i++;
    }
    return hashrate.toFixed(2) + byteUnits[i];
}

function getReadableSizeString(size){
    var i = 0;
    var byteUnits = [' B', ' kB', ' MB', ' GB', ' TB', ' PB'];
    while (size > 1024){
        size = size / 1024;
        i++;
    }
    return size.toFixed(2) + byteUnits[i];
}

function getReadableDifficultyString(difficulty){
    if (difficulty < 1000) return difficulty.toString();
    var i = 0;
    var byteUnits = [' ', ' k', ' M', ' G', ' T', ' P'];
    while (difficulty > 1000){
        difficulty = difficulty / 1000;
        i++;
    }
    return difficulty.toFixed(2) + byteUnits[i];
}

function getReadableHashesString(hashes){
    if (hashes < 1000) return hashes.toString() + ' H';
    var i = 0;
    var byteUnits = [' H', ' kH', ' MH', ' GH', ' TH', ' PH'];
    while (hashes > 1000){
        hashes = hashes / 1000;
        i++;
    }
    return hashes.toFixed(3) + byteUnits[i];
}

function getReadableTime(seconds){
    var units = [ [60, 'second'], [60, 'minute'], [24, 'hour'],
        [7, 'day'], [4, 'week'], [12, 'month'], [1, 'year'] ];

    function formatAmounts(amount, unit){
        var rounded = Math.round(amount);
        return '' + rounded + ' ' + unit + (rounded > 1 ? 's' : '');
    }

    var amount = seconds;
    for (var i = 0; i < units.length; i++){
        if (amount < units[i][0])
            return formatAmounts(amount, units[i][1]);
        amount = amount / units[i][0];
    }
    return formatAmounts(amount, units[units.length - 1][1]);
}

function getReadableCoins(coins, digits, withoutSymbol){
    var amount = (parseInt(coins || 0) / lastStats.config.coinUnits).toFixed(digits || lastStats.config.coinUnits.toString().length - 1);
    return amount + (withoutSymbol ? '' : (' ' + lastStats.config.symbol));
}

 
