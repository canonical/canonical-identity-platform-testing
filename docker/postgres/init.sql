-- Create users
CREATE USER kratos WITH PASSWORD 'kratos';
CREATE USER hydra WITH PASSWORD 'hydra';
CREATE USER openfga WITH PASSWORD 'openfga';
CREATE USER tenants WITH PASSWORD 'tenants';
CREATE USER hooks WITH PASSWORD 'hooks';
-- "authorization" is reserved: unquoted it aborted init on fresh volumes.
CREATE USER "authorization" WITH PASSWORD 'authorization';
CREATE USER sts WITH PASSWORD 'sts';
CREATE USER verification WITH PASSWORD 'verification';

-- Create databases
CREATE DATABASE kratos;
GRANT ALL PRIVILEGES ON DATABASE kratos TO kratos;
ALTER DATABASE kratos OWNER TO kratos;

CREATE DATABASE hydra;
GRANT ALL PRIVILEGES ON DATABASE hydra TO hydra;
ALTER DATABASE hydra OWNER TO hydra;

CREATE DATABASE openfga;
GRANT ALL PRIVILEGES ON DATABASE openfga TO openfga;
ALTER DATABASE openfga OWNER TO openfga;

CREATE DATABASE tenants;
GRANT ALL PRIVILEGES ON DATABASE tenants TO tenants;
ALTER DATABASE tenants OWNER TO tenants;

CREATE DATABASE hooks;
GRANT ALL PRIVILEGES ON DATABASE hooks TO hooks;
ALTER DATABASE hooks OWNER TO hooks;

CREATE DATABASE "authorization";
GRANT ALL PRIVILEGES ON DATABASE "authorization" TO "authorization";
ALTER DATABASE "authorization" OWNER TO "authorization";

CREATE DATABASE sts;
GRANT ALL PRIVILEGES ON DATABASE sts TO sts;
ALTER DATABASE sts OWNER TO sts;

CREATE DATABASE verification;
GRANT ALL PRIVILEGES ON DATABASE verification TO verification;
ALTER DATABASE verification OWNER TO verification;
