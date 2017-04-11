// fancy graph to quickly see how asset is trading [bbb--*----ss]
module.exports = function(lasttrade, distancefromlow, low, hi, buyTolerance, sellTolerance) {
	var width = 10;
	var move = Math.round(((hi-low)/hi)*100);
	var result = parseFloat(lasttrade).toFixed(5) + " | " + parseFloat(low).toFixed(5) + " [";
	for (i=0;i<=width;i++) {
		if ((i / width) * 100 >= distancefromlow && (i / width) * 100 < distancefromlow + (100 / width))
			result = result + "*";
		else if ((i / width) * 100 < buyTolerance)
			result = result + "b";
		else if ((i / width) * 100 > 100 - sellTolerance)
			result = result + "s";
		else
			result = result + "-";
	}

	result = result + "] " + parseFloat(hi).toFixed(5) + " (" + distancefromlow + "%/"+move+"%)";
	return result;
}
