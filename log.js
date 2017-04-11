// simple log helper
module.exports = function(string, asset) {
	var d = new Date();
	var datestring = ("0" + d.getDate()).slice(-2) + "-" + ("0"+(d.getMonth()+1)).slice(-2) + "-" + d.getFullYear() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
	console.log(datestring + (asset!=null?" "+asset+currency:null) + " " + string);
}
