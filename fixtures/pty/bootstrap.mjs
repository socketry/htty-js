import {encodeBootstrap} from "../../HTTY.js";

process.stdout.write("ignored output");
process.stdout.write("\u001bP+reset:test-token\u001b\\");
process.stdout.write(encodeBootstrap());
process.stdout.write("RAW");
