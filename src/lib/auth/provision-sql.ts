/**
 * First-login provisioning (D-79), one statement so two parallel first requests agree. Brands promised to this email's
 * invitation move to user_brand_access in the same statement, only for a newly inserted row (xmax = 0) and a verified
 * email ($2 is null otherwise), so an existing user can never pick them up. Params: clerk id, verified email, name, role.
 */
export const USER_COLUMNS = 'id, clerk_user_id, email, name, active, last_role_seen';

export const PROVISION_SQL = `WITH ins AS (
       INSERT INTO app_user (clerk_user_id, email, name, last_role_seen) VALUES ($1, $2::text, $3, $4)
       ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
       RETURNING ${USER_COLUMNS}, (xmax = 0) AS fresh
     ), moved AS (
       DELETE FROM invite_brand_access
        WHERE email = $2::text AND EXISTS (SELECT 1 FROM ins WHERE fresh)
       RETURNING brand_id
     ), granted AS (
       INSERT INTO user_brand_access (user_id, brand_id)
       SELECT ins.id, moved.brand_id FROM ins, moved
       ON CONFLICT DO NOTHING
     )
     SELECT ${USER_COLUMNS} FROM ins`;
