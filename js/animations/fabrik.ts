/**
 * A fabrik IK solver and utility for IK chains
 * @module
 */

const quat1 = new THREE.Quaternion();

/**
 * Solves the given chain of bones using fabrik solver to reach the target location, with an optional pole vector.
 * Modifies the vectors in the `bones` parameter with the resulting positions.
 */
export function fabrikIter(bones: THREE.Vector3[], target: THREE.Vector3, pole?: THREE.Vector3): void {
    let n = bones.length;

    let base_pos = bones[0].clone();
    let bases = bones.slice(0, -1);

    let distances = bases.map((bone, i) => {
        return bone.distanceTo(bones[i + 1]);
    });
    let total_length = distances.reduce((a, b) => a + b, 0);
    let dist = bones[0].distanceTo(target);

    if (dist > total_length) {
        // Target unreachable: stretch straight toward target
        for (let i = 0; i < n - 1; i++) {
            let pos = bones[i];
            let r = pos.distanceTo(target);
            let lambda = distances[i] / r;
            bones[i + 1].copy(
                bones[i].clone().multiplyScalar(1 - lambda).add(target.clone().multiplyScalar(lambda))
            );
        }
    } else {
        let diff = target.distanceTo(bones[n - 1]);
        const TOLERANCE = 0.001;
        let max_iterations = 100;
        while (diff > TOLERANCE && max_iterations > 0) {
            // Backward pass (tip -> root)
            bones[n - 1].copy(target);
            for (let i = n - 2; i >= 0; i--) {
                let p = bones[i];
                let p2 = bones[i + 1];
                let r = p.distanceTo(p2);
                let lambda = distances[i] / (r || 0.0001);
                bones[i].copy(
                    p2.clone().multiplyScalar(1 - lambda).add(p.clone().multiplyScalar(lambda))
                );
            }

            // Forward pass (root -> tip)
            bones[0].copy(base_pos);
            for (let i = 0; i < n - 1; i++) {
                let p = bones[i];
                let p2 = bones[i + 1];
                let r = p.distanceTo(p2);
                let lambda = distances[i] / (r || 0.0001);
                bones[i + 1].copy(
                    p.clone().multiplyScalar(1 - lambda).add(p2.clone().multiplyScalar(lambda))
                );
            }

            diff = target.distanceTo(bones[n - 1]);
            max_iterations--;
        }
    }

    // --- Pole Vector Alignment (Applied Post-Solve) ---
    // Only applies to chains with intermediate joints (n > 2) and need to bend to reach the target (dist < total_length)
    if (pole && n > 2 && dist < total_length) {
        let root = bones[0];
        let tip = bones[n - 1];

        let line_dir = tip.clone().sub(root).normalize();
        if (line_dir.lengthSq() < 1e-6) return;

        // Choose a key joint (usually middle joint) to determine current bend direction
        let mid_pos = bones[Math.floor((n - 1) / 2)];

        // Project current mid joint onto line root->tip
        let proj_mid = root.clone().add(
            line_dir.clone().multiplyScalar(mid_pos.clone().sub(root).dot(line_dir))
        );
        let current_plane_dir = mid_pos.clone().sub(proj_mid).normalize();

        // Project pole vector onto line root->tip plane
        let proj_pole = root.clone().add(
            line_dir.clone().multiplyScalar(pole.clone().sub(root).dot(line_dir))
        );
        let target_plane_dir = pole.clone().sub(proj_pole).normalize();

        // If both direction vectors are valid, rotate inner joints around root->tip axis
        if (current_plane_dir.lengthSq() > 1e-4 && target_plane_dir.lengthSq() > 1e-4) {
            let quaternion = quat1.setFromUnitVectors(current_plane_dir, target_plane_dir);

            for (let i = 1; i < n - 1; i++) {
                let offset = bones[i].clone().sub(root);
                offset.applyQuaternion(quaternion);
                bones[i].copy(root.clone().add(offset));
            }
        }
    }
}


/**
 * Returns the normal of the plane the chain bends in, oriented as `line x bend`, where `line` points from the root to the tip
 * and `bend` points from that line towards the inner joints. Returns null if the chain is straight or too short.
 */
export function getBendNormal(bones: THREE.Vector3[]): THREE.Vector3 | null {
    let n = bones.length;
    if (n < 3) return null;
    let root = bones[0];
    let line = bones[n - 1].clone().sub(root);
    if (line.lengthSq() < 1e-8) return null;
    line.normalize();

    // Sum over all inner joints so longer chains also produce a stable normal
    let normal = new THREE.Vector3();
    for (let i = 1; i < n - 1; i++) {
        let offset = bones[i].clone().sub(root);
        offset.sub(line.clone().multiplyScalar(offset.dot(line)));
        normal.add(line.clone().cross(offset));
    }
    if (normal.lengthSq() < 1e-6) return null;
    return normal.normalize();
}

/**
 * Returns the normal of the plane through the root, tip and pole, oriented the same way as `getBendNormal`
 * for a chain that bends towards the pole. Returns null if the pole lies on the line from root to tip.
 */
export function getPoleNormal(root: THREE.Vector3, tip: THREE.Vector3, pole: THREE.Vector3): THREE.Vector3 | null {
    let line = tip.clone().sub(root);
    if (line.lengthSq() < 1e-8) return null;
    line.normalize();
    let normal = line.cross(pole.clone().sub(root));
    if (normal.lengthSq() < 1e-6) return null;
    return normal.normalize();
}

/**
 * Rotates the inner joints of the chain around the line from root to tip by the given angle in radians
 */
export function rotateChainAroundAxis(bones: THREE.Vector3[], angle: number): void {
    let n = bones.length;
    if (n < 3 || !angle) return;
    let root = bones[0];
    let axis = bones[n - 1].clone().sub(root);
    if (axis.lengthSq() < 1e-8) return;
    quat1.setFromAxisAngle(axis.normalize(), angle);
    for (let i = 1; i < n - 1; i++) {
        bones[i].sub(root).applyQuaternion(quat1).add(root);
    }
}

/**
 * Returns the rotation of an orthonormal frame built from a bone direction and a hinge normal,
 * or null if the normal is parallel to the direction
 */
export function getBoneFrame(direction: THREE.Vector3, normal: THREE.Vector3, target: THREE.Quaternion): THREE.Quaternion | null {
    let hinge = normal.clone().sub(direction.clone().multiplyScalar(normal.dot(direction)));
    if (hinge.lengthSq() < 1e-6) return null;
    hinge.normalize();
    let third = direction.clone().cross(hinge);
    let matrix = new THREE.Matrix4().makeBasis(direction, hinge, third);
    return target.setFromRotationMatrix(matrix);
}
