# DB structure

## users

| column     | type      | notes                  |
|------------|-----------|------------------------|
| uuid       | uuid      | primary key            |
| created_at | timestamp |                        |
| updated_at | timestamp |                        |
| deleted    | boolean   | soft delete flag       |

## keys

| column     | type                 | notes                        |
|------------|----------------------|------------------------------|
| uuid       | uuid                 | primary key                  |
| user_uuid  | uuid                 | foreign key → users.uuid     |
| type       | enum('root','user')  |                              |
| created_at | timestamp            |                              |
| updated_at | timestamp            |                              |
| deleted    | boolean              | soft delete flag             |

## workspaces

| column     | type      | notes                  |
|------------|-----------|------------------------|
| uuid       | uuid      | primary key            |
| created_at | timestamp |                        |
| updated_at | timestamp |                        |
| deleted    | boolean   | soft delete flag       |

## apps

| column         | type      | notes                             |
|----------------|-----------|-----------------------------------|
| uuid           | uuid      | primary key                       |
| workspace_uuid | uuid      | foreign key → workspaces.uuid     |
| created_at     | timestamp |                                   |
| updated_at     | timestamp |                                   |
| deleted        | boolean   | soft delete flag                  |

## skills

| column     | type      | notes                       |
|------------|-----------|-----------------------------|
| uuid       | uuid      | primary key                 |
| app_uuid   | uuid      | foreign key → apps.uuid     |
| created_at | timestamp |                             |
| updated_at | timestamp |                             |
| deleted    | boolean   | soft delete flag            |

## schemas

| column     | type      | notes                       |
|------------|-----------|-----------------------------|
| uuid       | uuid      | primary key                 |
| app_uuid   | uuid      | foreign key → apps.uuid     |
| created_at | timestamp |                             |
| updated_at | timestamp |                             |
| deleted    | boolean   | soft delete flag            |

## fields

| column      | type      | notes                          |
|-------------|-----------|--------------------------------|
| uuid        | uuid      | primary key                    |
| schema_uuid | uuid      | foreign key → schemas.uuid     |
| created_at  | timestamp |                                |
| updated_at  | timestamp |                                |
| deleted     | boolean   | soft delete flag               |

## items

| column      | type      | notes                          |
|-------------|-----------|--------------------------------|
| uuid        | uuid      | primary key                    |
| schema_uuid | uuid      | foreign key → schemas.uuid     |
| created_at  | timestamp |                                |
| updated_at  | timestamp |                                |
| deleted     | boolean   | soft delete flag               |

## values

| column     | type      | notes                       |
|------------|-----------|-----------------------------|
| uuid       | uuid      | primary key                 |
| item_uuid  | uuid      | foreign key → items.uuid    |
| field_uuid | uuid      | foreign key → fields.uuid   |
| data       | jsonb     | any JSON type               |
| created_at | timestamp |                             |
| updated_at | timestamp |                             |
| deleted    | boolean   | soft delete flag            |

## hooks

| column     | type      | notes                       |
|------------|-----------|-----------------------------|
| uuid       | uuid      | primary key                 |
| app_uuid   | uuid      | foreign key → apps.uuid     |
| created_at | timestamp |                             |
| updated_at | timestamp |                             |
| deleted    | boolean   | soft delete flag            |

## files

| column     | type      | notes                                       |
|------------|-----------|---------------------------------------------|
| uuid       | uuid      | primary key                                 |
| app_uuid   | uuid      | foreign key → apps.uuid                     |
| token      | text      | grants upload/access; issued at request     |
| created_at | timestamp |                                             |
| updated_at | timestamp |                                             |
| deleted    | boolean   | soft delete flag                            |

Files are served to end users via signed requests, tracked in `file_requests`.

## file_requests

| column     | type      | notes                       |
|------------|-----------|-----------------------------|
| uuid       | uuid      | primary key                 |
| file_uuid  | uuid      | foreign key → files.uuid    |
| token      | text      | signature granting access   |
| expires_at | timestamp | when the signature expires  |
| created_at | timestamp |                             |
| updated_at | timestamp |                             |
| deleted    | boolean   | soft delete flag            |

## scopes

| column         | type                          | notes                                              |
|----------------|-------------------------------|----------------------------------------------------|
| uuid           | uuid                          | primary key                                        |
| user_uuid      | uuid                          | foreign key → users.uuid                           |
| workspace_uuid | uuid                          | nullable, foreign key → workspaces.uuid            |
| app_uuid       | uuid                          | nullable, foreign key → apps.uuid                  |
| role           | enum('admin','user','viewer') |                                                    |
| created_at     | timestamp                     |                                                    |
| updated_at     | timestamp                     |                                                    |
| deleted        | boolean                       | soft delete flag                                   |

Exactly one of `workspace_uuid` or `app_uuid` is set per row.
