#![no_std]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, IntoVal,
    String,
};

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum Status {
    Open,
    Assigned,
    Submitted,
    Paid,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Bounty {
    pub id: u64,
    pub creator: Address,
    pub title: String,
    pub description: String,
    pub reward: i128,
    pub deadline: u64,
    pub status: Status,
    pub builder: Option<Address>,
    pub proof: Option<String>,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Reputation,
    Asset,
    NextId,
    Bounty(u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EscrowError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotFound = 3,
    InvalidReward = 4,
    InvalidDeadline = 5,
    InvalidStatus = 6,
    Unauthorized = 7,
}

#[contract]
pub struct BountyEscrow;

fn transfer(env: &Env, asset: &Address, from: &Address, to: &Address, amount: i128) {
    env.invoke_contract::<()>(
        asset,
        &symbol_short!("transfer"),
        soroban_sdk::vec![
            env,
            from.clone().into_val(env),
            to.clone().into_val(env),
            amount.into_val(env)
        ],
    );
}

#[contractimpl]
impl BountyEscrow {
    pub fn initialize(env: Env, reputation: Address, asset: Address) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Reputation) {
            return Err(EscrowError::AlreadyInitialized);
        }
        env.storage()
            .instance()
            .set(&DataKey::Reputation, &reputation);
        env.storage().instance().set(&DataKey::Asset, &asset);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        Ok(())
    }

    pub fn create_bounty(
        env: Env,
        creator: Address,
        title: String,
        description: String,
        reward: i128,
        deadline: u64,
    ) -> Result<u64, EscrowError> {
        creator.require_auth();
        if reward <= 0 {
            return Err(EscrowError::InvalidReward);
        }
        if deadline <= u64::from(env.ledger().sequence()) {
            return Err(EscrowError::InvalidDeadline);
        }
        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(EscrowError::NotInitialized)?;
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        transfer(
            &env,
            &asset,
            &creator,
            &env.current_contract_address(),
            reward,
        );
        let bounty = Bounty {
            id,
            creator: creator.clone(),
            title,
            description,
            reward,
            deadline,
            status: Status::Open,
            builder: None,
            proof: None,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Bounty(id), &bounty);
        env.storage()
            .instance()
            .set(&DataKey::NextId, &id.saturating_add(1));
        env.events()
            .publish((symbol_short!("created"), creator, id), reward);
        Ok(id)
    }

    pub fn apply_bounty(env: Env, builder: Address, bounty_id: u64) -> Result<(), EscrowError> {
        builder.require_auth();
        let mut bounty: Bounty = env
            .storage()
            .persistent()
            .get(&DataKey::Bounty(bounty_id))
            .ok_or(EscrowError::NotFound)?;
        if bounty.status != Status::Open {
            return Err(EscrowError::InvalidStatus);
        }
        bounty.status = Status::Assigned;
        bounty.builder = Some(builder.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Bounty(bounty_id), &bounty);
        env.events()
            .publish((symbol_short!("applied"), builder, bounty_id), bounty_id);
        Ok(())
    }

    pub fn submit_work(
        env: Env,
        builder: Address,
        bounty_id: u64,
        proof: String,
    ) -> Result<(), EscrowError> {
        builder.require_auth();
        let mut bounty: Bounty = env
            .storage()
            .persistent()
            .get(&DataKey::Bounty(bounty_id))
            .ok_or(EscrowError::NotFound)?;
        if bounty.status != Status::Assigned || bounty.builder != Some(builder.clone()) {
            return Err(EscrowError::Unauthorized);
        }
        bounty.status = Status::Submitted;
        bounty.proof = Some(proof);
        env.storage()
            .persistent()
            .set(&DataKey::Bounty(bounty_id), &bounty);
        env.events()
            .publish((symbol_short!("submitted"), builder, bounty_id), bounty_id);
        Ok(())
    }

    pub fn approve_and_pay(env: Env, creator: Address, bounty_id: u64) -> Result<(), EscrowError> {
        creator.require_auth();
        let mut bounty: Bounty = env
            .storage()
            .persistent()
            .get(&DataKey::Bounty(bounty_id))
            .ok_or(EscrowError::NotFound)?;
        if bounty.creator != creator || bounty.status != Status::Submitted {
            return Err(EscrowError::Unauthorized);
        }
        let builder = bounty.builder.clone().ok_or(EscrowError::Unauthorized)?;
        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(EscrowError::NotInitialized)?;
        transfer(
            &env,
            &asset,
            &env.current_contract_address(),
            &builder,
            bounty.reward,
        );
        bounty.status = Status::Paid;
        env.storage()
            .persistent()
            .set(&DataKey::Bounty(bounty_id), &bounty);
        let reputation: Address = env
            .storage()
            .instance()
            .get(&DataKey::Reputation)
            .ok_or(EscrowError::NotInitialized)?;
        env.invoke_contract::<()>(
            &reputation,
            &soroban_sdk::Symbol::new(&env, "record_completion"),
            soroban_sdk::vec![
                &env,
                env.current_contract_address().into_val(&env),
                builder.clone().into_val(&env),
                bounty_id.into_val(&env),
                bounty.reward.into_val(&env)
            ],
        );
        env.events()
            .publish((symbol_short!("paid"), builder, bounty_id), bounty.reward);
        Ok(())
    }

    pub fn cancel_bounty(env: Env, creator: Address, bounty_id: u64) -> Result<(), EscrowError> {
        creator.require_auth();
        let mut bounty: Bounty = env
            .storage()
            .persistent()
            .get(&DataKey::Bounty(bounty_id))
            .ok_or(EscrowError::NotFound)?;
        if bounty.creator != creator || bounty.status != Status::Open {
            return Err(EscrowError::Unauthorized);
        }
        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(EscrowError::NotInitialized)?;
        transfer(
            &env,
            &asset,
            &env.current_contract_address(),
            &creator,
            bounty.reward,
        );
        bounty.status = Status::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Bounty(bounty_id), &bounty);
        env.events().publish(
            (symbol_short!("cancelled"), creator, bounty_id),
            bounty.reward,
        );
        Ok(())
    }

    pub fn get_bounty(env: Env, bounty_id: u64) -> Result<Bounty, EscrowError> {
        env.storage()
            .persistent()
            .get(&DataKey::Bounty(bounty_id))
            .ok_or(EscrowError::NotFound)
    }
    pub fn get_total(env: Env) -> u64 {
        env.storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::NextId)
            .unwrap_or(1)
            .saturating_sub(1)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use reputation::{Reputation, ReputationClient};
    use soroban_sdk::{contract, contractimpl, testutils::Address as _, Env};

    #[contract]
    pub struct MockToken;
    #[contractimpl]
    impl MockToken {
        pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) {}
    }

    #[test]
    fn full_bounty_lifecycle_calls_reputation() {
        let env = Env::default();
        env.mock_all_auths();
        let token = env.register(MockToken, ());
        let reputation = env.register(Reputation, ());
        let escrow = env.register(BountyEscrow, ());
        let r = ReputationClient::new(&env, &reputation);
        let e = BountyEscrowClient::new(&env, &escrow);
        let owner = Address::generate(&env);
        let builder = Address::generate(&env);
        r.initialize(&escrow);
        e.initialize(&reputation, &token);
        let id = e.create_bounty(
            &owner,
            &String::from_str(&env, "Indexer cleanup"),
            &String::from_str(&env, "Ship the event query."),
            &500,
            &(u64::from(env.ledger().sequence()) + 100),
        );
        e.apply_bounty(&builder, &id);
        e.submit_work(
            &builder,
            &id,
            &String::from_str(&env, "https://github.com/acme/pr/7"),
        );
        e.approve_and_pay(&owner, &id);
        assert_eq!(e.get_bounty(&id).status, Status::Paid);
        assert_eq!(r.get_profile(&builder).completions, 1);
    }
}
