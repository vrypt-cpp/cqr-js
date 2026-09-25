import { encode, renderAscii, renderSvg } from '@vrypt-cpp/cqr';

const code = encode('HELLO WORLD');
console.log(`version=${code.version} size=${code.size} mask=${code.mask} ecc=${code.ecc}`);
console.log(renderAscii(code));
console.log(renderSvg(code, { scale: 4, border: 4 }).slice(0, 120) + '...');
