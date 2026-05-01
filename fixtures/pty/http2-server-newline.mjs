import {Server} from "../../HTTY.js";

Server.open((stream) => {
	stream.respond({
		":status": 200,
		"content-type": "text/plain",
	});
	stream.end("OK\n");
});
