# Sheet System

The sheet system coordinates user- and service-initiated operations across shared workspace state, spreadsheets, and messaging platforms.

## Identity and authorization

**Effective Principal**:
The authenticated user or service whose permissions are evaluated and who owns the resulting operation.
_Avoid_: Caller identity, delegated caller

**User Principal**:
An effective principal representing a person, identified by the system user and optionally associated with a Discord account.
_Avoid_: Discord user, account user

**Service Principal**:
An effective principal representing an autonomous trusted service rather than a person.
_Avoid_: Service user, sentinel user

**Actor Provenance**:
The service that acted for an effective principal, retained for attribution without granting or changing the principal's authority.
_Avoid_: Delegated identity, impersonated user

**Discord Account**:
An optional Discord identity associated with a user principal; it is not the user's platform-independent identity.
_Avoid_: User ID

**Workspace Capabilities**:
The permissions an effective principal currently holds in a workspace, derived from messaging-platform membership and roles, configured monitor roles, and application ownership.
_Avoid_: Token permissions, delegated permissions

**Authorization Decision**:
The allow or deny result of applying a versioned operation policy to an effective principal and the current relevant capabilities.
_Avoid_: Permission snapshot, scope check

**Audit Attribution**:
The record of both the effective principal whose authority was used and any service actor that performed the operation for that principal.
_Avoid_: Caller ID, impersonation record
