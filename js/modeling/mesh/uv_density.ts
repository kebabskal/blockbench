// Keep UV density: when mesh vertices are moved or resized, faces keep their texture pixel size instead of stretching
// the texture. Each face's current mapping from its plane to the UV map is extended to the new vertex positions,
// so the side that doesn't move keeps its UVs and the moving side extends into or crops the texture, like cubes do.

type FaceUVMap = {
	vertices: string[]
	origin: THREE.Vector3
	u_axis: THREE.Vector3
	v_axis: THREE.Vector3
	// UV = [a*s + b*t + c, d*s + e*t + f] for plane coordinates s, t
	coefficients: [number, number, number, number, number, number]
	start_positions: Record<string, ArrayVector3>
	start_uv: Record<string, ArrayVector2>
}
export type MeshUVMaps = Record<string, FaceUVMap>

function solve3(m: number[][], r: number[]): number[] | null {
	let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
		- m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
		+ m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
	if (Math.abs(det) < 1e-9) return null;
	let replace = (column: number) => m.map((row, i) => row.map((value, j) => j == column ? r[i] : value));
	let detOf = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
		- a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
		+ a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
	return [0, 1, 2].map(column => detOf(replace(column)) / det);
}

/**
 * Remember how every face of the mesh maps onto the texture before an edit
 */
export function captureMeshUVMaps(mesh: Mesh): MeshUVMaps {
	let maps: MeshUVMaps = {};
	for (let fkey in mesh.faces) {
		let face = mesh.faces[fkey];
		let vkeys = face.vertices;
		if (vkeys.length < 3 || !vkeys.every(vkey => face.uv[vkey] && mesh.vertices[vkey])) continue;

		let positions = vkeys.map(vkey => new THREE.Vector3().fromArray(mesh.vertices[vkey]));
		let normal = new THREE.Vector3().fromArray(face.getNormal(true));
		if (normal.lengthSq() < 1e-9) continue;
		let origin = positions[0].clone();
		let u_axis = positions.map(p => p.clone().sub(origin)).find(d => d.lengthSq() > 1e-9);
		if (!u_axis) continue;
		u_axis.sub(normal.clone().multiplyScalar(u_axis.dot(normal))).normalize();
		let v_axis = normal.clone().cross(u_axis).normalize();
		let plane_coords = positions.map(p => {
			let d = p.clone().sub(origin);
			return [d.dot(u_axis), d.dot(v_axis)];
		});

		// Use the largest triangle of the face for a stable fit
		let best: [number, number, number] | null = null;
		let best_area = 1e-6;
		for (let i = 0; i < vkeys.length; i++) {
			for (let j = i + 1; j < vkeys.length; j++) {
				for (let k = j + 1; k < vkeys.length; k++) {
					let [a, b, c] = [plane_coords[i], plane_coords[j], plane_coords[k]];
					let area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
					if (area > best_area) {
						best_area = area;
						best = [i, j, k];
					}
				}
			}
		}
		if (!best) continue;
		let matrix = best.map(i => [plane_coords[i][0], plane_coords[i][1], 1]);
		let u = solve3(matrix, best.map(i => face.uv[vkeys[i]][0]));
		let v = solve3(matrix, best.map(i => face.uv[vkeys[i]][1]));
		if (!u || !v) continue;

		let start_positions: Record<string, ArrayVector3> = {};
		let start_uv: Record<string, ArrayVector2> = {};
		vkeys.forEach(vkey => {
			start_positions[vkey] = mesh.vertices[vkey].slice() as ArrayVector3;
			start_uv[vkey] = face.uv[vkey].slice() as ArrayVector2;
		});
		maps[fkey] = {
			vertices: vkeys.slice(),
			origin, u_axis, v_axis,
			coefficients: [u[0], u[1], u[2], v[0], v[1], v[2]],
			start_positions, start_uv,
		};
	}
	return maps;
}

/**
 * Update the UVs of the faces whose shape changed since the maps were captured
 */
export function applyMeshUVMaps(mesh: Mesh, maps: MeshUVMaps): boolean {
	let changed = false;
	for (let fkey in maps) {
		let map = maps[fkey];
		let face = mesh.faces[fkey];
		if (!face || !map.vertices.every(vkey => mesh.vertices[vkey] && face.uv[vkey])) continue;

		// A face that only moved as a whole keeps its UVs, like a moved cube
		let offsets = map.vertices.map(vkey => mesh.vertices[vkey].map((value, i) => value - map.start_positions[vkey][i]));
		let rigid = offsets.every(offset => offset.every((value, i) => Math.abs(value - offsets[0][i]) < 1e-5));
		if (rigid) {
			map.vertices.forEach(vkey => {
				face.uv[vkey][0] = map.start_uv[vkey][0];
				face.uv[vkey][1] = map.start_uv[vkey][1];
			});
			continue;
		}
		let [a, b, c, d, e, f] = map.coefficients;
		map.vertices.forEach(vkey => {
			let p = new THREE.Vector3().fromArray(mesh.vertices[vkey]).sub(map.origin);
			let s = p.dot(map.u_axis);
			let t = p.dot(map.v_axis);
			face.uv[vkey][0] = Math.roundTo(a * s + b * t + c, 4);
			face.uv[vkey][1] = Math.roundTo(d * s + e * t + f, 4);
		});
		changed = true;
	}
	return changed;
}

BARS.defineActions(() => {
	new Toggle('keep_mesh_uv_density', {
		icon: 'grid_on',
		category: 'edit',
		condition: {modes: ['edit'], features: ['meshes']},
		default: true,
		save_on_restart: true,
	})
})

declare global {
	interface BarItemRegistry {
		keep_mesh_uv_density: Toggle
	}
}
