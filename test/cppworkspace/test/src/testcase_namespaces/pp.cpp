#include "pp.hpp"
#include <iostream>

namespace prettyprinting {
    bank_account::bank_account(int id, std::string name, float rate) : base_t(new base_t::base_tuple{id, name, rate}) { }

    void bank_account::print_values() const {
        const base_t::base_tuple& t = *base_t::ts;
        const auto& [id, name, rate] = t;
        std::cout << "id: " << id;
        std::cout.flush();
        std::cout << " Account owner: " << name;
        std::cout.flush();
        std::cout << " at rate: " << (100.0f * rate) - 100.0f << "%" << std::endl;
    }

    person_t::person_t(int id, std::string name, bank_account* acc) : id(id), name(name), account(acc) {}

    employee_t::employee_t(int id, std::string name, bank_account* acc, std::string position) : person_t(id, name, acc), position(position) {}

    struct Hidden {
        int i, j;
    };

    void main() {
        std::tuple<int, Hidden> tup{42, Hidden{1,2}};
        bank_account b{1, "john doe", 1.05f};
        b.print_values();
        employee_t janedoe{2, "jane doe", new bank_account{2, "jane doe", 1.08f}, "manager"};
        janedoe.account->print_values();
        std::cout << "closing for the day" << std::endl;
    }
}
