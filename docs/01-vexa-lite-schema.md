  * \-- WARNING: This schema is for context only and is not meant to be run.  
  * \-- Table order and constraints may not be valid for execution.  
  *   
  * CREATE TABLE public.api\_tokens (  
  *   id integer NOT NULL DEFAULT nextval('api\_tokens\_id\_seq'::regclass),  
  *   token character varying NOT NULL,  
  *   user\_id integer NOT NULL,  
  *   scopes ARRAY NOT NULL DEFAULT '{}'::text\[\],  
  *   name character varying,  
  *   created\_at timestamp without time zone DEFAULT now(),  
  *   last\_used\_at timestamp without time zone,  
  *   expires\_at timestamp without time zone,  
  *   CONSTRAINT api\_tokens\_pkey PRIMARY KEY (id),  
  *   CONSTRAINT api\_tokens\_user\_id\_fkey FOREIGN KEY (user\_id) REFERENCES public.users(id)  
  * );  
  * CREATE TABLE public.calendar\_events (  
  *   id integer NOT NULL DEFAULT nextval('calendar\_events\_id\_seq'::regclass),  
  *   user\_id integer NOT NULL,  
  *   external\_event\_id text NOT NULL,  
  *   title text,  
  *   start\_time timestamp with time zone NOT NULL,  
  *   end\_time timestamp with time zone,  
  *   meeting\_url text,  
  *   platform text,  
  *   status text NOT NULL DEFAULT 'pending'::text,  
  *   meeting\_id integer,  
  *   sync\_token text,  
  *   created\_at timestamp without time zone DEFAULT now(),  
  *   CONSTRAINT calendar\_events\_pkey PRIMARY KEY (id),  
  *   CONSTRAINT calendar\_events\_meeting\_id\_fkey FOREIGN KEY (meeting\_id) REFERENCES public.meetings(id)  
  * );  
  * CREATE TABLE public.media\_files (  
  *   id integer NOT NULL DEFAULT nextval('media\_files\_id\_seq'::regclass),  
  *   recording\_id integer NOT NULL,  
  *   type character varying NOT NULL,  
  *   format character varying NOT NULL,  
  *   storage\_path character varying NOT NULL,  
  *   storage\_backend character varying NOT NULL,  
  *   file\_size\_bytes integer,  
  *   duration\_seconds double precision,  
  *   metadata jsonb NOT NULL DEFAULT '{}'::jsonb,  
  *   created\_at timestamp without time zone DEFAULT now(),  
  *   CONSTRAINT media\_files\_pkey PRIMARY KEY (id),  
  *   CONSTRAINT media\_files\_recording\_id\_fkey FOREIGN KEY (recording\_id) REFERENCES public.recordings(id)  
  * );  
  * CREATE TABLE public.meeting\_sessions (  
  *   id integer NOT NULL DEFAULT nextval('meeting\_sessions\_id\_seq'::regclass),  
  *   meeting\_id integer NOT NULL,  
  *   session\_uid character varying NOT NULL,  
  *   session\_start\_time timestamp with time zone NOT NULL DEFAULT now(),  
  *   CONSTRAINT meeting\_sessions\_pkey PRIMARY KEY (id),  
  *   CONSTRAINT meeting\_sessions\_meeting\_id\_fkey FOREIGN KEY (meeting\_id) REFERENCES public.meetings(id)  
  * );  
  * CREATE TABLE public.meetings (  
  *   id integer NOT NULL DEFAULT nextval('meetings\_id\_seq'::regclass),  
  *   user\_id integer NOT NULL,  
  *   platform character varying NOT NULL,  
  *   platform\_specific\_id character varying,  
  *   status character varying NOT NULL,  
  *   bot\_container\_id character varying,  
  *   start\_time timestamp without time zone,  
  *   end\_time timestamp without time zone,  
  *   data jsonb NOT NULL,  
  *   created\_at timestamp without time zone DEFAULT now(),  
  *   updated\_at timestamp without time zone DEFAULT now(),  
  *   CONSTRAINT meetings\_pkey PRIMARY KEY (id)  
  * );  
  * CREATE TABLE public.recordings (  
  *   id integer NOT NULL DEFAULT nextval('recordings\_id\_seq'::regclass),  
  *   meeting\_id integer,  
  *   user\_id integer NOT NULL,  
  *   session\_uid character varying,  
  *   source character varying NOT NULL,  
  *   status character varying NOT NULL,  
  *   error\_message text,  
  *   created\_at timestamp without time zone DEFAULT now(),  
  *   completed\_at timestamp without time zone,  
  *   CONSTRAINT recordings\_pkey PRIMARY KEY (id),  
  *   CONSTRAINT recordings\_meeting\_id\_fkey FOREIGN KEY (meeting\_id) REFERENCES public.meetings(id)  
  * );  
  * CREATE TABLE public.transcriptions (  
  *   id integer NOT NULL DEFAULT nextval('transcriptions\_id\_seq'::regclass),  
  *   meeting\_id integer NOT NULL,  
  *   start\_time double precision NOT NULL,  
  *   end\_time double precision NOT NULL,  
  *   text text NOT NULL,  
  *   speaker character varying,  
  *   language character varying,  
  *   created\_at timestamp without time zone,  
  *   session\_uid character varying,  
  *   segment\_id character varying,  
  *   CONSTRAINT transcriptions\_pkey PRIMARY KEY (id),  
  *   CONSTRAINT transcriptions\_meeting\_id\_fkey FOREIGN KEY (meeting\_id) REFERENCES public.meetings(id)  
  * );  
  * CREATE TABLE public.users (  
  *   id integer NOT NULL DEFAULT nextval('users\_id\_seq'::regclass),  
  *   email character varying NOT NULL,  
  *   name character varying,  
  *   image\_url text,  
  *   created\_at timestamp without time zone DEFAULT now(),  
  *   max\_concurrent\_bots integer NOT NULL DEFAULT 1,  
  *   data jsonb NOT NULL DEFAULT '{}'::jsonb,  
  *   CONSTRAINT users\_pkey PRIMARY KEY (id)  
  * );