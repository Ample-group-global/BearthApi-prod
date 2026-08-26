import { keccak256 } from "ethereum-cryptography/keccak";
function encodeLeaf(address: string): Buffer {
  const bytes = Buffer.from(address.toLowerCase().slice(2), "hex");
  return Buffer.from(keccak256(bytes));
}
function hashPair(a: Buffer, b: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak256(Buffer.concat([lo, hi])));
}

export interface MerkleTree {
  layers: Buffer[][];
  root: string;
}

export function buildMerkleTree(addresses: string[]): MerkleTree {
  if (!addresses.length) return { layers: [], root: "0x" + "0".repeat(64) };

  const leaves = addresses.map(encodeLeaf);
  const layers: Buffer[][] = [leaves.slice()];
  let layer = leaves.slice();

  while (layer.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < layer.length - 1; i += 2) {
      next.push(hashPair(layer[i], layer[i + 1]));
    }
    if (layer.length % 2 === 1) next.push(layer[layer.length - 1]);
    layer = next;
    layers.push(layer.slice());
  }

  return { layers, root: "0x" + layers[layers.length - 1][0].toString("hex") };
}

export function getProof(tree: MerkleTree, address: string): string[] {
  if (!tree.layers.length) return [];
  const target = encodeLeaf(address);
  let idx = tree.layers[0].findIndex(l => l.equals(target));
  if (idx === -1) return [];
  const proof: string[] = [];
  for (let lv = 0; lv < tree.layers.length - 1; lv++) {
    const sibling = idx ^ 1;
    if (sibling < tree.layers[lv].length) {
      proof.push("0x" + tree.layers[lv][sibling].toString("hex"));
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}
