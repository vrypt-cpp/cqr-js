import { encode, decodeMatrixUtf8, decodeText } from '@vrypt-cpp/cqr';

const code = encode('Hello, decoder!');
const { bytes, info } = decodeMatrixUtf8(code.modules, code.size);
console.log('decoded:', Buffer.from(bytes).toString('utf-8'), 'v' + info.version);

const { text } = decodeText(code.modules, code.size);
console.log('text:', text);
