import sys
from capstone import *
hexs = sys.argv[1]; start = int(sys.argv[2], 16); off = int(sys.argv[3], 16) if len(sys.argv) > 3 else 0
code = bytes.fromhex(hexs)[off:]
md = Cs(CS_ARCH_X86, CS_MODE_16)
for i in md.disasm(code, start + off):
    print(f"{i.address:05x}: {i.bytes.hex():<14} {i.mnemonic} {i.op_str}")
